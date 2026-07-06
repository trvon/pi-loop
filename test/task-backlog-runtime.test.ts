import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTO_TASK_WORKER_PROMPT,
  createTaskBacklogRuntime,
  type TaskBacklogRuntimeOptions,
} from "../src/runtime/task-backlog-runtime.js";
import { TaskStore } from "../src/task-store.js";
import type { LoopEntry, Trigger } from "../src/types.js";

// Faithful copy of index.ts triggerHasEventSource semantics.
function triggerHasEventSource(trigger: Trigger | string, source: string): boolean {
  if (typeof trigger === "string") return false;
  return trigger.type === "event"
    ? trigger.source === source
    : trigger.type === "hybrid"
      ? trigger.event.source === source
      : false;
}

const tasksCreatedTrigger: Trigger = { type: "event", source: "tasks:created" };

function makeLoop(overrides: Partial<LoopEntry> = {}): LoopEntry {
  return {
    id: "1",
    prompt: AUTO_TASK_WORKER_PROMPT,
    trigger: tasksCreatedTrigger,
    status: "active",
    recurring: true,
    createdAt: 10,
    updatedAt: 10,
    expiresAt: 10 + 7 * 24 * 60 * 60 * 1000,
    fireCount: 0,
    ...overrides,
  };
}

function setup(overrides: Partial<TaskBacklogRuntimeOptions> = {}) {
  const loops: LoopEntry[] = [];
  let nextId = 1;
  const createLoop = vi.fn((trigger: Trigger, prompt: string, o: { recurring: boolean; taskBacklog?: boolean; maxFires?: number }) => {
    const entry = makeLoop({ id: String(nextId++), trigger, prompt, taskBacklog: o.taskBacklog, maxFires: o.maxFires });
    loops.push(entry);
    return entry;
  });
  const deleteLoop = vi.fn((id: string) => {
    const i = loops.findIndex((l) => l.id === id);
    if (i >= 0) loops.splice(i, 1);
  });
  const opts: TaskBacklogRuntimeOptions = {
    getLoops: () => loops,
    createLoop,
    deleteLoop,
    recordDeletionTombstone: vi.fn(),
    addTrigger: vi.fn(),
    removeTrigger: vi.fn(),
    updateWidget: vi.fn(),
    hasPendingTasks: vi.fn(async () => 0),
    bootstrapTaskLoop: vi.fn(async () => true),
    triggerHasEventSource,
    emitLoopAutodeleted: vi.fn(),
    emitTaskBacklogEmpty: vi.fn(),
    ...overrides,
  };
  return { runtime: createTaskBacklogRuntime(opts), opts, loops };
}

describe("task-backlog-runtime predicates", () => {
  it("identifies an auto-task worker loop", () => {
    const { runtime } = setup();
    expect(runtime.isAutoTaskWorkerLoop(makeLoop())).toBe(true);
    expect(runtime.isAutoTaskWorkerLoop(makeLoop({ prompt: "something else" }))).toBe(false);
    expect(runtime.isAutoTaskWorkerLoop(makeLoop({ status: "paused" }))).toBe(false);
    expect(runtime.isAutoTaskWorkerLoop(makeLoop({ trigger: { type: "cron", schedule: "*/5 * * * *" } }))).toBe(false);
  });

  it("identifies a task-backlog loop (worker OR taskBacklog flag)", () => {
    const { runtime } = setup();
    expect(runtime.isTaskBacklogLoop(makeLoop())).toBe(true);
    expect(runtime.isTaskBacklogLoop(makeLoop({ prompt: "x", taskBacklog: true }))).toBe(true);
    expect(runtime.isTaskBacklogLoop(makeLoop({ prompt: "x", taskBacklog: false }))).toBe(false);
  });

  it("finds the auto-task worker loop among many", () => {
    const { runtime, loops } = setup();
    loops.push(makeLoop({ id: "7", prompt: "unrelated", trigger: { type: "cron", schedule: "*/5 * * * *" } }));
    loops.push(makeLoop({ id: "8" }));
    expect(runtime.findAutoTaskWorkerLoop()?.id).toBe("8");
  });
});

describe("ensureAutoTaskWorkerLoop", () => {
  let taskStore: TaskStore;
  beforeEach(() => {
    taskStore = new TaskStore();
  });

  it("does nothing below the threshold", async () => {
    const { runtime, opts } = setup();
    for (let i = 0; i < 4; i++) taskStore.create(`t${i}`, "d");
    const result = await runtime.ensureAutoTaskWorkerLoop(taskStore);
    expect(result).toEqual({ created: false });
    expect(opts.createLoop).not.toHaveBeenCalled();
  });

  it("creates a hybrid worker loop at/above the threshold", async () => {
    const { runtime, opts } = setup();
    for (let i = 0; i < 5; i++) taskStore.create(`t${i}`, "d");
    const result = await runtime.ensureAutoTaskWorkerLoop(taskStore);
    expect(result.created).toBe(true);
    expect(result.entry?.trigger).toEqual({
      type: "hybrid",
      cron: "*/3 * * * *",
      event: { source: "tasks:created" },
      debounceMs: 30000,
    });
    expect(result.entry?.maxFires).toBe(30);
    expect(opts.addTrigger).toHaveBeenCalledTimes(1);
    expect(opts.bootstrapTaskLoop).toHaveBeenCalledTimes(1);
    expect(opts.updateWidget).toHaveBeenCalled();
  });

  it("dedups — does not create a second worker loop when one exists", async () => {
    const { runtime, opts, loops } = setup();
    loops.push(makeLoop({ id: "9" }));
    for (let i = 0; i < 6; i++) taskStore.create(`t${i}`, "d");
    const result = await runtime.ensureAutoTaskWorkerLoop(taskStore);
    expect(result).toEqual({ entry: loops[0], created: false });
    expect(opts.createLoop).not.toHaveBeenCalled();
  });
});

describe("cleanupTaskBacklogLoops", () => {
  it("deletes backlog loops when zero tasks are pending and emits explicit signals", async () => {
    const { runtime, opts, loops } = setup({ hasPendingTasks: vi.fn(async () => 0) });
    loops.push(makeLoop({ id: "1" }));
    const cleaned = await runtime.cleanupTaskBacklogLoops();
    expect(cleaned).toBe(1);
    expect(opts.removeTrigger).toHaveBeenCalledWith("1");
    expect(opts.recordDeletionTombstone).toHaveBeenCalledWith("1", { reason: "task_backlog_empty", pendingCount: 0 });
    expect(opts.deleteLoop).toHaveBeenCalledWith("1");
    expect(opts.emitTaskBacklogEmpty).toHaveBeenCalledWith({
      pendingCount: 0,
      deletedLoopIds: ["1"],
      source: "task_backlog_runtime",
    });
    expect(opts.emitLoopAutodeleted).toHaveBeenCalledWith(
      expect.objectContaining({
        loopId: "1",
        reason: "task_backlog_empty",
        source: "task_backlog_runtime",
        pendingCount: 0,
      }),
    );

    const callOrder = (fn: unknown) => (fn as { mock: { invocationCallOrder: number[] } }).mock.invocationCallOrder[0];
    expect(callOrder(opts.emitTaskBacklogEmpty)).toBeLessThan(callOrder(opts.removeTrigger));
    expect(callOrder(opts.removeTrigger)).toBeLessThan(callOrder(opts.recordDeletionTombstone));
    expect(callOrder(opts.recordDeletionTombstone)).toBeLessThan(callOrder(opts.deleteLoop));
    expect(callOrder(opts.deleteLoop)).toBeLessThan(callOrder(opts.emitLoopAutodeleted));
  });

  it("keeps backlog loops when tasks are still pending", async () => {
    const { runtime, opts, loops } = setup({ hasPendingTasks: vi.fn(async () => 3) });
    loops.push(makeLoop({ id: "1" }));
    expect(await runtime.cleanupTaskBacklogLoops()).toBe(0);
    expect(opts.deleteLoop).not.toHaveBeenCalled();
  });

  it("keeps backlog loops when pending count is unavailable (-1)", async () => {
    const { runtime, opts, loops } = setup({ hasPendingTasks: vi.fn(async () => -1) });
    loops.push(makeLoop({ id: "1" }));
    expect(await runtime.cleanupTaskBacklogLoops()).toBe(0);
    expect(opts.deleteLoop).not.toHaveBeenCalled();
  });

  it("returns 0 with no backlog loops present", async () => {
    const { runtime, opts } = setup();
    expect(await runtime.cleanupTaskBacklogLoops()).toBe(0);
    expect(opts.hasPendingTasks).not.toHaveBeenCalled();
  });
});

describe("evaluateTaskBacklog", () => {
  it("creates a worker loop when pendingCount is at/above threshold", async () => {
    const taskStore = new TaskStore();
    for (let i = 0; i < 5; i++) taskStore.create(`t${i}`, "d");
    const { runtime } = setup();
    const result = await runtime.evaluateTaskBacklog(taskStore, 5);
    expect(result.created).toBe(true);
    expect(result.entry).toBeDefined();
  });

  it("cleans up worker loops when pendingCount is zero", async () => {
    const { runtime, loops } = setup({ hasPendingTasks: vi.fn(async () => 0) });
    loops.push(makeLoop({ id: "1" }));
    const result = await runtime.evaluateTaskBacklog(undefined, 0);
    expect(result.created).toBe(false);
    expect(result.cleaned).toBe(1);
  });
});
