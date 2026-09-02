import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskStore } from "../src/task-store.js";

describe("TaskStore (in-memory)", () => {
  let store: TaskStore;

  beforeEach(() => {
    store = new TaskStore();
  });

  it("creates tasks with auto-incrementing IDs", () => {
    const t1 = store.create("one", "desc one");
    const t2 = store.create("two", "desc two");

    expect(t1.id).toBe("1");
    expect(t2.id).toBe("2");
    expect(t1.status).toBe("pending");
  });

  it("starts tasks explicitly", () => {
    store.create("task", "desc");
    const entry = store.start("1");

    expect(entry?.status).toBe("in_progress");
  });

  it("completes tasks explicitly and stamps completedAt", () => {
    store.create("task", "desc");
    store.start("1");
    const entry = store.complete("1");

    expect(entry?.status).toBe("completed");
    expect(typeof entry?.completedAt).toBe("number");
  });

  it("closes tasks without completing them", () => {
    store.create("task", "desc");
    const entry = store.close("1");

    expect(entry?.status).toBe("closed");
    expect(typeof entry?.closedAt).toBe("number");
    expect(entry?.completedAt).toBeUndefined();
  });

  it("reopens tasks explicitly and preserves completedAt", () => {
    store.create("task", "desc");
    store.start("1");
    store.complete("1");
    const completedAt = store.get("1")?.completedAt;

    const entry = store.reopen("1");
    expect(entry?.status).toBe("pending");
    expect(entry?.completedAt).toBe(completedAt);
  });

  it("rejects claim leases beyond the one-hour safety bound", () => {
    store.create("task", "desc");
    expect(store.claim("1", {
      claimId: "claim-1",
      ownerSessionId: "session-a",
      ownerRuntimeId: "runtime-a",
      leaseMs: 3_600_001,
    })).toBeUndefined();
  });

  it("claims pending work and rejects a live foreign owner", () => {
    store.create("task", "desc");
    const claimed = store.claim("1", {
      claimId: "claim-1",
      ownerSessionId: "session-a",
      ownerRuntimeId: "runtime-a",
      now: 1_000,
      leaseMs: 5_000,
    });

    expect(claimed).toMatchObject({
      takenOver: false,
      renewed: false,
      entry: {
        status: "in_progress",
        claim: {
          claimId: "claim-1",
          ownerSessionId: "session-a",
          ownerRuntimeId: "runtime-a",
          claimedAt: 1_000,
          heartbeatAt: 1_000,
          leaseExpiresAt: 6_000,
          attempt: 1,
        },
      },
    });
    expect(store.claim("1", {
      claimId: "claim-2",
      ownerSessionId: "session-b",
      ownerRuntimeId: "runtime-b",
      now: 2_000,
      leaseMs: 5_000,
    })).toBeUndefined();
  });

  it("renews the same owner and permits takeover only after expiry", () => {
    store.create("task", "desc");
    store.claim("1", {
      claimId: "claim-1",
      ownerSessionId: "session-a",
      ownerRuntimeId: "runtime-a",
      now: 1_000,
      leaseMs: 1_000,
    });

    const renewed = store.claim("1", {
      claimId: "ignored-new-id",
      ownerSessionId: "session-a",
      ownerRuntimeId: "runtime-a",
      now: 1_500,
      leaseMs: 1_000,
    });
    expect(renewed).toMatchObject({
      takenOver: false,
      renewed: true,
      entry: { claim: { claimId: "claim-1", heartbeatAt: 1_500, leaseExpiresAt: 2_500, attempt: 1 } },
    });

    const takeover = store.claim("1", {
      claimId: "claim-2",
      ownerSessionId: "session-b",
      ownerRuntimeId: "runtime-b",
      now: 2_501,
      leaseMs: 1_000,
    });
    expect(takeover).toMatchObject({
      takenOver: true,
      entry: { claim: { claimId: "claim-2", attempt: 2, leaseExpiresAt: 3_501 } },
    });
  });

  it("issues a new token when the same owner reclaims after expiry", () => {
    store.create("task", "desc");
    store.claim("1", {
      claimId: "claim-1",
      ownerSessionId: "session-a",
      ownerRuntimeId: "runtime-a",
      now: 1_000,
      leaseMs: 1_000,
    });

    const reclaimed = store.claim("1", {
      claimId: "claim-2",
      ownerSessionId: "session-a",
      ownerRuntimeId: "runtime-a",
      now: 2_001,
      leaseMs: 1_000,
    });

    expect(reclaimed).toMatchObject({
      takenOver: false,
      renewed: false,
      entry: { claim: { claimId: "claim-2", attempt: 2, leaseExpiresAt: 3_001 } },
    });
  });

  it("requires the live claim token for deletion", () => {
    store.create("task", "desc");
    store.claim("1", {
      claimId: "claim-1",
      ownerSessionId: "session-a",
      ownerRuntimeId: "runtime-a",
      now: 1_000,
      leaseMs: 1_000,
    });

    expect(store.delete("1", undefined, 1_500)).toBe(false);
    expect(store.delete("1", "wrong", 1_500)).toBe(false);
    expect(store.delete("1", "claim-1", 2_001)).toBe(false);
    expect(store.delete("1", "claim-1", 1_500)).toBe(true);
  });

  it("requires the claim token for heartbeat and completion", () => {
    store.create("task", "desc");
    store.claim("1", {
      claimId: "claim-1",
      ownerSessionId: "session-a",
      ownerRuntimeId: "runtime-a",
      now: 1_000,
      leaseMs: 1_000,
    });

    expect(store.heartbeat("1", "wrong", 1_500, 1_000)).toBeUndefined();
    expect(store.heartbeat("1", "claim-1", 1_500, 3_600_001)).toBeUndefined();
    expect(store.heartbeat("1", "claim-1", 1_500, 1_000)?.claim?.leaseExpiresAt).toBe(2_500);
    expect(store.heartbeat("1", "claim-1", 2_501, 1_000)).toBeUndefined();
    expect(store.complete("1", "wrong", 2_000)).toBeUndefined();
    expect(store.complete("1", "claim-1", 2_000)?.status).toBe("completed");
    expect(store.get("1")?.claim).toBeUndefined();
  });

  it("updates task details explicitly", () => {
    store.create("old", "old desc");
    const entry = store.updateDetails("1", { subject: "new", description: "new desc" });

    expect(entry?.subject).toBe("new");
    expect(entry?.description).toBe("new desc");
    expect(entry?.status).toBe("pending");
  });

  it("checks claim ownership and revision inside the detail-update lock", () => {
    store.create("task", "desc");
    const beforeClaimRevision = store.get("1")?.revision;
    store.claim("1", {
      claimId: "claim-1",
      ownerSessionId: "session-a",
      ownerRuntimeId: "runtime-a",
      now: 1_000,
      leaseMs: 1_000,
    });

    expect(store.updateDetails("1", { description: "missing bearer" }, { now: 1_500 })).toBeUndefined();
    expect(store.updateDetails("1", { description: "wrong bearer" }, { claimId: "wrong", now: 1_500 })).toBeUndefined();
    expect(store.updateDetails("1", { description: "stale read" }, {
      claimId: "claim-1",
      expectedRevision: beforeClaimRevision,
      now: 1_500,
    })).toBeUndefined();
    expect(store.get("1")?.description).toBe("desc");

    expect(store.updateDetails("1", { description: "owned update" }, {
      claimId: "claim-1",
      expectedRevision: store.get("1")?.revision,
      now: 1_500,
    })?.description).toBe("owned update");
    expect(store.updateDetails("1", { description: "expired update" }, {
      claimId: "claim-1",
      now: 2_001,
    })).toBeUndefined();
    expect(store.get("1")?.description).toBe("owned update");
  });

  it("returns undefined for missing lifecycle/detail updates", () => {
    expect(store.start("999")).toBeUndefined();
    expect(store.complete("999")).toBeUndefined();
    expect(store.close("999")).toBeUndefined();
    expect(store.reopen("999")).toBeUndefined();
    expect(store.updateDetails("999", { subject: "missing" })).toBeUndefined();
  });

  it("prunes completed and closed tasks", () => {
    store.create("done", "d1");
    store.create("closed", "d2");
    store.create("active", "d3");
    store.complete("1");
    store.close("2");
    store.start("3");

    expect(store.pruneCompleted()).toBe(2);
    expect(store.list()).toHaveLength(1);
    expect(store.get("1")).toBeUndefined();
    expect(store.get("2")).toBeUndefined();
    expect(store.get("3")?.status).toBe("in_progress");
  });
});

describe("TaskStore (file-backed)", () => {
  const filePath = join(tmpdir(), `pi-loop-tasks-${Date.now()}.json`);

  afterEach(() => {
    rmSync(filePath, { force: true });
    rmSync(filePath + ".lock", { force: true });
    rmSync(filePath + ".tmp", { force: true });
  });

  it("persists explicit lifecycle and detail updates", () => {
    const store1 = new TaskStore(filePath);
    store1.create("task", "desc");
    store1.start("1");
    store1.updateDetails("1", { subject: "updated" });

    const store2 = new TaskStore(filePath);
    expect(store2.get("1")?.status).toBe("in_progress");
    expect(store2.get("1")?.subject).toBe("updated");
  });

  it("refreshes reads only when the backing file changes", () => {
    const store1 = new TaskStore(filePath);
    const store2 = new TaskStore(filePath);

    store1.create("first", "desc");
    expect(store2.list()).toHaveLength(1);

    store1.create("second", "desc");
    expect(store2.list()).toHaveLength(2);
    expect(store2.get("2")?.subject).toBe("second");
  });

  it("preserves monotonic ids after prune", () => {
    const store1 = new TaskStore(filePath);
    store1.create("done", "desc");
    store1.complete("1");
    store1.pruneCompleted();

    const next = store1.create("next", "desc");
    expect(next.id).toBe("2");
  });
});
