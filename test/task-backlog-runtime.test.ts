import { describe, expect, it, vi } from "vitest";
import {
  AUTO_TASK_WORKER_LEGACY_PROMPTS,
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

const LEGACY_WORKER_PROMPT =
  "Run TaskList, pick next pending task, mark it in_progress, implement it, run validation, and complete it. If no pending tasks remain, report that and end this iteration; pi-loop manages the worker lifecycle automatically.";

const IMMEDIATELY_PREVIOUS_WORKER_PROMPT =
  "Run TaskList and inspect every in_progress task before choosing a pending task; read each pending task's description and use TaskGet whenever an excerpt is truncated. Follow each prerequisite chain to the earliest unfinished task. Use TaskClaim for that task whether it is pending or in_progress; an expired claim can be taken over, but a live foreign claim must not be duplicated. Resume claimed in_progress work before claiming unrelated pending work. Keep the returned claimId, call TaskHeartbeat before its lease expires during long work, and pass claimId to TaskUpdate when completing or closing the task. Prefer a pending task with no unresolved prerequisite. If task A names B as its next task, or B says it depends on A, complete A before B. Never choose a dependent task while its prerequisite is pending or in_progress. Never report no eligible task while any in_progress task exists: claim and resume it, verify evidence and complete it, or report its live owner/blocker and required recovery. Implement the claimed task, run validation, and complete it. If no unfinished tasks remain, report that and end this iteration; pi-loop manages the worker lifecycle automatically.";

const PREVIOUS_WORKER_PROMPT =
  "Run TaskList and inspect every in_progress task before choosing a pending task; read each pending task's description and use TaskGet whenever an excerpt is truncated. Resume an eligible in_progress task before claiming new work. If a dependent task is blocked, follow its prerequisite chain to the earliest unfinished task and resume it when it is in_progress. Prefer a pending task with no unresolved prerequisite. If task A names B as its next task, or B says it depends on A, complete A before B. Never choose a dependent task while its prerequisite is pending or in_progress. Never report no eligible task while any in_progress task exists: resume it, verify evidence and complete it, or report why it is actively owned or blocked and what recovery is required. Mark newly claimed work in_progress, implement it, run validation, and complete it. If no unfinished tasks remain, report that and end this iteration; pi-loop manages the worker lifecycle automatically.";

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
  const deleteLoop = vi.fn((id: string) => {
    const i = loops.findIndex((l) => l.id === id);
    if (i >= 0) loops.splice(i, 1);
  });
  const opts: TaskBacklogRuntimeOptions = {
    getLoops: () => loops,
    deleteLoop,
    updateLoopWorker: vi.fn((id: string, prompt: string) => {
      const entry = loops.find((loop) => loop.id === id);
      if (!entry) return undefined;
      entry.prompt = prompt;
      entry.taskBacklog = true;
      return entry;
    }),
    recordDeletionTombstone: vi.fn(),
    removeTrigger: vi.fn(),
    updateWidget: vi.fn(),
    hasPendingTasks: vi.fn(async () => 0),
    adoptLoop: vi.fn(),
    triggerHasEventSource,
    emitLoopAutodeleted: vi.fn(),
    emitTaskBacklogEmpty: vi.fn(),
    ...overrides,
  };
  return { runtime: createTaskBacklogRuntime(opts), opts, loops };
}

describe("task-backlog-runtime predicates", () => {
  it("teaches the worker to honor task descriptions and next-task sequencing", () => {
    expect(AUTO_TASK_WORKER_PROMPT).toContain("read each pending task's description");
    expect(AUTO_TASK_WORKER_PROMPT).toMatch(/next task/i);
    expect(AUTO_TASK_WORKER_PROMPT).toMatch(/prefer/i);
  });

  it("teaches the worker to use TaskGet for full descriptions", () => {
    expect(AUTO_TASK_WORKER_PROMPT).toMatch(/TaskGet/i);
  });

  it("requires action before status prose or another wake", () => {
    expect(AUTO_TASK_WORKER_PROMPT).toContain("ACTION REQUIRED NOW");
    expect(AUTO_TASK_WORKER_PROMPT).toContain("First tool call: TaskList");
    expect(AUTO_TASK_WORKER_PROMPT).toMatch(/claim or resume.*same turn/i);
    expect(AUTO_TASK_WORKER_PROMPT).toMatch(/do not end.*reporting state/i);
    expect(AUTO_TASK_WORKER_PROMPT).toMatch(/future-tense promise/i);
    expect(AUTO_TASK_WORKER_PROMPT).toContain("Tool calls, not a plan");
    expect(AUTO_TASK_WORKER_PROMPT).toMatch(/describing intended work does not count/i);
    expect(AUTO_TASK_WORKER_PROMPT).toMatch(/TaskGet.*execution authority/i);
    expect(AUTO_TASK_WORKER_PROMPT).toMatch(/do not invent.*blocker/i);
    expect(AUTO_TASK_WORKER_PROMPT).toMatch(/validation.*observable tool result/i);
    expect(AUTO_TASK_WORKER_PROMPT).toMatch(/reasoning-only validation does not count/i);
    expect(AUTO_TASK_WORKER_PROMPT).toMatch(/run the validation.*TaskGet requires/i);
    expect(AUTO_TASK_WORKER_PROMPT).toMatch(/reads and edits.*do not prove validation/i);
  });

  it("orders a prerequisite A before its dependent B", () => {
    expect(AUTO_TASK_WORKER_PROMPT).toContain("no unresolved prerequisite");
    expect(AUTO_TASK_WORKER_PROMPT).toContain("complete A before B");
    expect(AUTO_TASK_WORKER_PROMPT).toMatch(/never.*dependent.*prerequisite/i);
  });

  it("resumes unfinished work instead of waiting forever on in-progress tasks", () => {
    expect(AUTO_TASK_WORKER_PROMPT).toMatch(/inspect.*in_progress.*before.*pending/i);
    expect(AUTO_TASK_WORKER_PROMPT).toMatch(/resume.*in_progress/i);
    expect(AUTO_TASK_WORKER_PROMPT).toMatch(/follow.*prerequisite.*chain/i);
    expect(AUTO_TASK_WORKER_PROMPT).toMatch(/never report.*no eligible.*in_progress/i);
    expect(AUTO_TASK_WORKER_PROMPT).toContain("TaskClaim");
    expect(AUTO_TASK_WORKER_PROMPT).toContain("TaskHeartbeat");
    expect(AUTO_TASK_WORKER_PROMPT).toMatch(/pass claimId to TaskUpdate/i);
  });

  it("retains previous worker prompts for persisted loops", () => {
    expect(AUTO_TASK_WORKER_LEGACY_PROMPTS).toContain(IMMEDIATELY_PREVIOUS_WORKER_PROMPT);
    expect(AUTO_TASK_WORKER_LEGACY_PROMPTS).toContain(PREVIOUS_WORKER_PROMPT);
  });

  it("migrates persisted worker prompts to the current recovery contract", () => {
    const { runtime, loops, opts } = setup();
    loops.push(
      makeLoop({ id: "8", prompt: PREVIOUS_WORKER_PROMPT, fireCount: 7 }),
      makeLoop({ id: "9", prompt: AUTO_TASK_WORKER_PROMPT, taskBacklog: undefined }),
    );

    expect(runtime.migrateAutoTaskWorkerPrompts()).toBe(2);
    expect(opts.updateLoopWorker).toHaveBeenCalledWith("8", AUTO_TASK_WORKER_PROMPT);
    expect(opts.updateLoopWorker).toHaveBeenCalledWith("9", AUTO_TASK_WORKER_PROMPT);
    expect(loops.every((entry) => entry.taskBacklog)).toBe(true);
    expect(loops[0]).toMatchObject({
      id: "8",
      prompt: AUTO_TASK_WORKER_PROMPT,
      fireCount: 7,
      recurring: true,
    });
  });

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

  it("still recognizes a worker loop persisted with the legacy prompt", () => {
    const { runtime, loops } = setup();
    loops.push(makeLoop({ id: "7", prompt: LEGACY_WORKER_PROMPT }));
    expect(runtime.isAutoTaskWorkerLoop(loops[0]!)).toBe(true);
    expect(runtime.findAutoTaskWorkerLoop()?.id).toBe("7");
  });

  it("auto-deletes a legacy-prompt worker loop when the queue drains", async () => {
    const { runtime, opts, loops } = setup();
    loops.push(makeLoop({ id: "7", prompt: LEGACY_WORKER_PROMPT }));
    opts.hasPendingTasks = vi.fn(async () => 0);

    await runtime.cleanupTaskBacklogLoops();

    expect(loops).toHaveLength(0);
  });
});

describe("task backlog adoption", () => {
  it("adopts every explicit or legacy worker while unfinished tasks remain", async () => {
    const { runtime, opts, loops } = setup({ hasPendingTasks: vi.fn(async () => 2) });
    loops.push(
      makeLoop({ id: "1", prompt: "explicit", taskBacklog: true }),
      makeLoop({ id: "2", prompt: AUTO_TASK_WORKER_PROMPT }),
      makeLoop({ id: "3", prompt: "plain watcher", taskBacklog: false }),
    );

    expect(await runtime.adoptTaskBacklogLoops()).toBe(2);
    expect(opts.adoptLoop).toHaveBeenCalledTimes(2);
    expect(opts.adoptLoop).toHaveBeenNthCalledWith(1, loops[0]);
    expect(opts.adoptLoop).toHaveBeenNthCalledWith(2, loops[1]);
  });

  it("skips workers that already fired after the agent turn began", async () => {
    const { runtime, opts, loops } = setup({ hasPendingTasks: vi.fn(async () => 1) });
    loops.push(makeLoop({ taskBacklog: true, fireCount: 3 }));

    expect(await runtime.adoptTaskBacklogLoops(new Map([["1", 2]]))).toBe(0);
    expect(opts.adoptLoop).not.toHaveBeenCalled();
  });

  it("adopts a worker whose fire count did not change during the agent turn", async () => {
    const { runtime, opts, loops } = setup({ hasPendingTasks: vi.fn(async () => 1) });
    loops.push(makeLoop({ taskBacklog: true, fireCount: 2 }));

    expect(await runtime.adoptTaskBacklogLoops(new Map([["1", 2]]))).toBe(1);
    expect(opts.adoptLoop).toHaveBeenCalledWith(loops[0]);
  });

  it("does not adopt when unfinished task state is empty or unavailable", async () => {
    const hasPendingTasks = vi.fn(async () => 0);
    const { runtime, opts, loops } = setup({ hasPendingTasks });
    loops.push(makeLoop({ taskBacklog: true }));

    expect(await runtime.adoptTaskBacklogLoops()).toBe(0);
    hasPendingTasks.mockResolvedValueOnce(-1);
    expect(await runtime.adoptTaskBacklogLoops()).toBe(0);
    expect(opts.adoptLoop).not.toHaveBeenCalled();
  });
});

describe("explicit backlog policy", () => {
  it("does not create an autonomous worker when five tasks are pending", async () => {
    const taskStore = new TaskStore();
    const { runtime, loops } = setup();
    for (let i = 0; i < 5; i++) taskStore.create(`t${i}`, "d");

    const result = await runtime.evaluateTaskBacklog(taskStore, 5);

    expect(result).toEqual({ created: false, cleaned: 0 });
    expect(loops).toHaveLength(0);
  });
});

describe("cleanupTaskBacklogLoops", () => {
  it("does not mutate backlog loops when its session guard becomes stale during lookup", async () => {
    let resolvePending: ((pending: number) => void) | undefined;
    const pending = new Promise<number>((resolve) => {
      resolvePending = resolve;
    });
    let current = true;
    const { runtime, opts, loops } = setup({ hasPendingTasks: vi.fn(() => pending) });
    loops.push(makeLoop({ id: "1" }));

    const cleanup = runtime.cleanupTaskBacklogLoops(() => current);
    current = false;
    resolvePending?.(0);

    expect(await cleanup).toBe(0);
    expect(loops).toHaveLength(1);
    expect(opts.deleteLoop).not.toHaveBeenCalled();
  });

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
  it("leaves a non-empty backlog for an explicitly created worker", async () => {
    const taskStore = new TaskStore();
    for (let i = 0; i < 5; i++) taskStore.create(`t${i}`, "d");
    const { runtime } = setup();
    expect(await runtime.evaluateTaskBacklog(taskStore, 5)).toEqual({ created: false, cleaned: 0 });
  });

  it("cleans up worker loops when pendingCount is zero", async () => {
    const { runtime, loops } = setup({ hasPendingTasks: vi.fn(async () => 0) });
    loops.push(makeLoop({ id: "1" }));
    const result = await runtime.evaluateTaskBacklog(undefined, 0);
    expect(result.created).toBe(false);
    expect(result.cleaned).toBe(1);
  });
});
