import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GoalStore } from "../src/goal-store.js";
import type { GoalCriteria } from "../src/goal-types.js";
import { emptyGoalProgress } from "./helpers/factories.js";

function criteria(): GoalCriteria {
  return {
    success: { minCompletedTasks: 1 },
  };
}

const progress = emptyGoalProgress;

describe("GoalStore (in-memory)", () => {
  let store: GoalStore;

  beforeEach(() => {
    store = new GoalStore();
  });

  it("creates goals with auto-incrementing IDs", () => {
    const g1 = store.create("one", "desc one", { taskIds: ["1"] }, criteria());
    const g2 = store.create("two", "desc two", {}, criteria());

    expect(g1.id).toBe("1");
    expect(g2.id).toBe("2");
    expect(g1.status).toBe("pending");
    expect(g1.verificationStatus).toBe("unknown");
  });

  it("activates goals explicitly", () => {
    store.create("goal", "desc", {}, criteria());
    const entry = store.activate("1");

    expect(entry?.status).toBe("active");
    expect(entry?.activatedAt).toBeDefined();
  });

  it("records projected progress explicitly", () => {
    store.create("goal", "desc", {}, criteria());
    const entry = store.recordProgress("1", progress({ totalTasks: 2, pendingTasks: 1, lastProgressAt: 123 }));

    expect(entry?.progress.totalTasks).toBe(2);
    expect(entry?.progress.pendingTasks).toBe(1);
    expect(entry?.progress.lastProgressAt).toBe(123);
  });

  it("marks goals blocked and unblocked explicitly", () => {
    store.create("goal", "desc", {}, criteria());
    const blocked = store.markBlocked("1", "required loop missing", progress({ activeLoops: 0 }));
    expect(blocked?.status).toBe("blocked");
    expect(blocked?.verificationStatus).toBe("inconclusive");
    expect(blocked?.verification.lastReason).toBe("required loop missing");

    const unblocked = store.unblock("1");
    expect(unblocked?.status).toBe("active");
  });

  it("marks goals verified terminally", () => {
    store.create("goal", "desc", {}, criteria());
    store.activate("1");
    store.markVerificationStarted("1");
    const entry = store.markVerified("1", "success criteria satisfied", progress({ completedTasks: 1 }));

    expect(entry?.status).toBe("satisfied");
    expect(entry?.verificationStatus).toBe("verified");
    expect(entry?.verification.passes).toBe(1);
    expect(entry?.resolvedAt).toBeDefined();
  });

  it("marks goals failed explicitly", () => {
    store.create("goal", "desc", {}, criteria());
    store.activate("1");
    const entry = store.markFailed("1", "monitor errored", progress({ erroredMonitors: 1 }));

    expect(entry?.status).toBe("failed");
    expect(entry?.verification.lastReason).toBe("monitor errored");
    expect(entry?.resolvedAt).toBeDefined();
  });

  it("updates goal details explicitly", () => {
    store.create("old", "old desc", {}, criteria());
    const entry = store.updateDetails("1", {
      title: "new",
      description: "new desc",
      scope: { taskIds: ["2"] },
      criteria: { success: { requiredTaskIds: ["2"] } },
      metadata: { phase: "advisory" },
    });

    expect(entry).toMatchObject({
      title: "new",
      description: "new desc",
      scope: { taskIds: ["2"] },
      criteria: { success: { requiredTaskIds: ["2"] } },
      metadata: { phase: "advisory" },
    });
  });

  it("archives goals explicitly", () => {
    store.create("goal", "desc", {}, criteria());
    const entry = store.archive("1", "manual close");

    expect(entry?.status).toBe("archived");
    expect(entry?.verification.lastReason).toBe("manual close");
    expect(entry?.resolvedAt).toBeDefined();
  });

  it("returns undefined for missing goal lifecycle/detail updates", () => {
    expect(store.activate("999")).toBeUndefined();
    expect(store.recordProgress("999", progress())).toBeUndefined();
    expect(store.markVerificationStarted("999")).toBeUndefined();
    expect(store.markVerified("999", "ok")).toBeUndefined();
    expect(store.markFailed("999", "fail")).toBeUndefined();
    expect(store.markBlocked("999", "blocked")).toBeUndefined();
    expect(store.unblock("999")).toBeUndefined();
    expect(store.updateDetails("999", { title: "missing" })).toBeUndefined();
    expect(store.archive("999", "done")).toBeUndefined();
  });
});

describe("GoalStore (file-backed)", () => {
  const testListId = `test-goals-${Date.now()}`;
  const goalsDir = join(homedir(), ".pi", "goals");
  const filePath = join(goalsDir, `${testListId}.json`);

  afterEach(() => {
    rmSync(filePath, { force: true });
    rmSync(filePath + ".lock", { force: true });
    rmSync(filePath + ".tmp", { force: true });
  });

  it("persists explicit lifecycle and detail updates", () => {
    const store1 = new GoalStore(testListId);
    store1.create("goal", "desc", {}, criteria());
    store1.activate("1");
    store1.recordProgress("1", progress({ totalTasks: 1, inProgressTasks: 1 }));
    store1.updateDetails("1", { title: "updated" });

    const store2 = new GoalStore(testListId);
    expect(store2.get("1")?.status).toBe("active");
    expect(store2.get("1")?.progress.totalTasks).toBe(1);
    expect(store2.get("1")?.title).toBe("updated");
  });

  it("refreshes reads only when the backing file changes", () => {
    const store1 = new GoalStore(testListId);
    const store2 = new GoalStore(testListId);

    store1.create("first", "desc", {}, criteria());
    expect(store2.list()).toHaveLength(1);

    store1.create("second", "desc", {}, criteria());
    expect(store2.list()).toHaveLength(2);
    expect(store2.get("2")?.title).toBe("second");
  });
});
