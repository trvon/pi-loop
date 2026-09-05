import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoopStore } from "../src/store.js";

const dirs: string[] = [];
const owner = { sessionId: "session-a", runtimeId: "runtime-a", generation: 1 };

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "pi-loop-orchestration-"));
  dirs.push(dir);
  const path = join(dir, "loops.json");
  return { path, store: new LoopStore(path) };
}

afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("LoopStore orchestration authority", () => {
  it.each(["autoTask", "taskBacklog"] as const)("rejects orchestration projection through %s", (flag) => {
    const { store } = makeStore();
    expect(() => store.create({ type: "dynamic" }, "Parallel review", {
      recurring: true,
      [flag]: true,
      orchestration: {
        owner,
        definition: { goal: "Parallel review", work: [{ prompt: "Inspect" }] },
      },
    })).toThrow(/orchestration.*standalone task/i);
    expect(store.list()).toEqual([]);
  });

  it("persists the finite batch and applies orchestration CAS under the store lock", () => {
    const { path, store } = makeStore();
    const entry = store.create({ type: "dynamic" }, "Parallel review", {
      recurring: true,
      dynamic: { goal: "Parallel review", awaitingUpdate: true },
      orchestration: {
        owner,
        definition: {
          goal: "Parallel review",
          work: [{ prompt: "Inspect API" }, { prompt: "Inspect runtime" }],
          concurrency: 1,
          maxAttempts: 2,
        },
      },
    });

    expect(entry.orchestration).toMatchObject({ revision: 1, status: "active" });
    const mutation = store.mutateOrchestration(entry.id, {
      type: "dispatch_requested",
      at: 200,
      expected: { revision: 1, ownerRuntimeId: owner.runtimeId, generation: owner.generation },
      workId: "1",
      dispatchId: "dispatch-1",
    });
    expect(mutation.applied).toBe(true);
    expect(new LoopStore(path).get(entry.id)?.orchestration?.work[0]).toMatchObject({
      status: "active",
      attemptCount: 1,
      dispatches: [{ dispatchId: "dispatch-1", status: "spawning" }],
    });
  });

  it("pauses expired orchestration evidence instead of deleting it", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const store = new LoopStore();
    const entry = store.create({ type: "dynamic" }, "Parallel review", {
      recurring: true,
      orchestration: { owner, definition: { goal: "Parallel review", work: [{ prompt: "Inspect" }] } },
    });
    vi.setSystemTime(new Date("2026-01-09T00:00:00Z"));

    expect(store.clearExpired()).toBe(1);
    expect(store.get(entry.id)?.status).toBe("paused");
    expect(store.get(entry.id)?.orchestration).toBeDefined();
  });

  it("keeps rejected orchestration mutations byte-preserving", () => {
    const { path, store } = makeStore();
    const entry = store.create({ type: "dynamic" }, "Parallel review", {
      recurring: true,
      orchestration: { owner, definition: { goal: "Parallel review", work: [{ prompt: "Inspect" }] } },
    });
    const before = readFileSync(path, "utf8");

    const rejected = store.mutateOrchestration(entry.id, {
      type: "dispatch_requested",
      at: 200,
      expected: { revision: 99, ownerRuntimeId: owner.runtimeId, generation: owner.generation },
      workId: "1",
      dispatchId: "stale",
    });

    expect(rejected).toMatchObject({ applied: false, reason: "stale_revision" });
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});
