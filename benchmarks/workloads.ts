import { cronToNextFire } from "../src/loop-parse.js";
import { type LoopReducerEvent, type LoopReducerState, reduceLoopState } from "../src/loop-reducer.js";
import { applyOrchestrationEvent, createOrchestrationState, getOrchestrationCapacity, getOrchestrationCounts } from "../src/orchestration-reducer.js";
import { LoopStore } from "../src/store.js";
import { reduceTaskState, type TaskReducerEvent, type TaskReducerState } from "../src/task-reducer.js";
import { TaskStore } from "../src/task-store.js";
import type { WorkflowDefinition } from "../src/types.js";
import { PANEL_WIDTH, renderProgressPanel } from "../src/ui/progress-panel-overlay.js";
import { createWorkflowRun, transitionWorkflowRun } from "../src/workflow-reducer.js";

const cronCases = [
  ["*/5 * * * *", "2026-01-01T00:00:00Z"],
  ["0 9 * * 1-5", "2026-01-02T09:01:00Z"],
  ["15 14 1 * *", "2026-01-01T00:00:00Z"],
  ["0 0 29 2 *", "2028-02-28T00:00:00Z"],
] as const;

function buildLoopState(): LoopReducerState {
  let state: LoopReducerState = { nextId: 1, loopsById: {} };
  for (let index = 0; index < 25; index++) {
    state = reduceLoopState(state, {
      type: "LOOP_CREATED",
      at: index,
      source: "system",
      payload: {
        prompt: `loop-${index}`,
        trigger: { type: "cron", schedule: "*/5 * * * *" },
        recurring: true,
        expiresAt: index + 604_800_000,
      },
    }).state;
  }
  return state;
}

const loopState = buildLoopState();
const loopEvents: LoopReducerEvent[] = Array.from({ length: 1_000 }, (_, index) => {
  const id = String((index % 25) + 1);
  const types = ["LOOP_FIRED", "LOOP_PAUSED", "LOOP_RESUMED"] as const;
  const type = types[index % types.length] ?? "LOOP_FIRED";
  return type === "LOOP_PAUSED"
    ? { type, at: 1_000 + index, source: "system", payload: { id, kind: "administrative" } }
    : { type, at: 1_000 + index, source: "system", payload: { id } };
});

function buildTaskState(): TaskReducerState {
  let state: TaskReducerState = { nextId: 1, tasksById: {} };
  for (let index = 0; index < 200; index++) {
    state = reduceTaskState(state, {
      type: "TASK_CREATED",
      at: index,
      source: "system",
      payload: { subject: `task-${index}`, description: "benchmark" },
    }).state;
  }
  return state;
}

const taskState = buildTaskState();
const taskEvents: TaskReducerEvent[] = Array.from({ length: 1_000 }, (_, index) => {
  const id = String((index % 200) + 1);
  const at = 1_000 + index;
  switch (index % 4) {
    case 0:
      return { type: "TASK_STARTED", at, source: "system", payload: { id } };
    case 1:
      return {
        type: "TASK_UPDATED",
        at,
        source: "system",
        payload: { id, description: `updated-${index}` },
      };
    case 2:
      return { type: "TASK_COMPLETED", at, source: "system", payload: { id } };
    default:
      return { type: "TASK_REOPENED", at, source: "system", payload: { id } };
  }
});

const workflowDefinition: WorkflowDefinition = {
  version: 1,
  initialState: "left",
  states: {
    left: { prompt: "Move right", on: { next: "right" } },
    right: { prompt: "Move left", on: { next: "left" } },
  },
};

const loopStore = new LoopStore();
for (let index = 0; index < 25; index++) {
  loopStore.create({ type: "cron", schedule: "*/5 * * * *" }, `loop-${index}`, {
    recurring: true,
  });
}

const taskStore = new TaskStore();
for (let index = 0; index < 200; index++) {
  taskStore.create(`task-${index}`, "benchmark");
}

export function runCronWorkload(): number {
  let checksum = 0;
  for (const [schedule, from] of cronCases) {
    checksum += cronToNextFire(schedule, new Date(from))?.getTime() ?? 0;
  }
  return checksum;
}

export function runLoopReducerWorkload(): number {
  let state = loopState;
  for (const event of loopEvents) state = reduceLoopState(state, event).state;
  return Object.values(state.loopsById).reduce(
    (sum, loop) => sum + (loop.fireCount ?? 0) + (loop.status === "active" ? 1 : 0),
    state.nextId,
  );
}

export function runTaskReducerWorkload(): number {
  let state = taskState;
  for (const event of taskEvents) state = reduceTaskState(state, event).state;
  return Object.values(state.tasksById).reduce(
    (sum, task) => sum + Number(task.id) + task.description.length,
    state.nextId,
  );
}

export function runWorkflowWorkload(): number {
  let run = createWorkflowRun(workflowDefinition, 0);
  for (let index = 0; index < 1_000; index++) {
    const result = transitionWorkflowRun(run, { outcome: "next" }, index + 1);
    if (!result.applied) throw new Error(result.error);
    run = result.run;
  }
  return run.transitionSeq + run.currentState.length + Object.values(run.attemptsByState).reduce(
    (sum, attempts) => sum + attempts,
    0,
  );
}

export function runStoreReadWorkload(): number {
  const loops = loopStore.list();
  const tasks = taskStore.list();
  return loops.length + tasks.length + Number(loops.at(-1)?.id ?? 0) + Number(tasks.at(-1)?.id ?? 0);
}

// Worst realistic panel frame: more workflows than are detailed, and a full task store.
const panelLoopStore = new LoopStore();
for (let index = 0; index < 4; index++) {
  panelLoopStore.create({ type: "dynamic" }, `panel-workflow-${index}`, {
    recurring: true,
    workflow: {
      version: 1,
      initialState: "s0",
      states: Object.fromEntries(Array.from({ length: 12 }, (_, state) => [
        `s${state}`,
        state === 11
          ? { prompt: "Done.", terminal: "completed" as const }
          : { prompt: `Phase ${state}.`, task: { subject: `phase-${state}`, description: "benchmark" }, on: { next: `s${state + 1}` } },
      ])),
    },
  });
}
const panelTheme = { fg: (_tone: string, text: string) => text } as Parameters<typeof renderProgressPanel>[0];

/** One side-panel frame: store reads plus layout and framing, as on each repaint. */
export function runProgressPanelWorkload(): number {
  const lines = renderProgressPanel(
    panelTheme,
    { loops: panelLoopStore.list(), tasks: taskStore.list(), now: 1_000_000 },
    PANEL_WIDTH,
  );
  return lines.reduce((sum, line) => sum + line.length, lines.length);
}

const orchestrationOwner = { sessionId: "bench", runtimeId: "bench", generation: 1 };

/**
 * One full 32-item aimd batch through the reducer: fill the window, bind, and
 * settle with usage evidence, including an overload, a slow run and a launch
 * the provider refused for good, so the window's cut, delay and refusal paths
 * are on the profile, not only the ACK path.
 */
export function runOrchestrationWorkload(): number {
  let state = createOrchestrationState({
    goal: "benchmark batch",
    work: Array.from({ length: 32 }, (_, index) => ({ prompt: `work ${index}` })),
    pacing: "aimd",
    maxAttempts: 2,
  }, orchestrationOwner, 0);
  let at = 1;
  let settled = 0;
  const expected = () => ({ revision: state.revision, ownerRuntimeId: orchestrationOwner.runtimeId, generation: orchestrationOwner.generation });
  const apply = (event: Parameters<typeof applyOrchestrationEvent>[1]) => {
    const result = applyOrchestrationEvent(state, event);
    if (!result.applied) throw new Error(result.reason ?? "orchestration benchmark event rejected");
    state = result.state;
  };
  while (state.status === "active") {
    for (const item of state.work) {
      if (item.status !== "pending" || getOrchestrationCounts(state).active >= getOrchestrationCapacity(state)) continue;
      const dispatchId = `d${at}`;
      apply({ type: "dispatch_requested", at: at++, expected: expected(), workId: item.id, dispatchId });
      // One launch is refused for good; the item keeps an attempt, so the batch still completes.
      if (item.id === "5" && item.attemptCount === 0) {
        apply({ type: "dispatch_spawn_failed", at: at++, expected: expected(), workId: item.id, dispatchId, error: "Unknown agent: bench", permanent: true });
        continue;
      }
      apply({ type: "dispatch_bound", at: at++, expected: expected(), workId: item.id, dispatchId, agentId: `a${dispatchId}` });
    }
    const active = state.work.find((item) => item.status === "active");
    const agentId = active?.dispatches.at(-1)?.agentId;
    if (!agentId) throw new Error("orchestration benchmark stalled");
    settled += 1;
    const overloaded = settled === 9;
    const slow = settled === 17 || settled === 18;
    apply({
      type: "dispatch_settled",
      at: at++,
      expected: expected(),
      agentId,
      outcome: overloaded ? "failed" : "completed",
      result: overloaded ? undefined : "done",
      error: overloaded ? "503 overloaded" : undefined,
      usage: { toolUses: settled % 3 === 0 ? 0 : 6, durationMs: (slow ? 9_000 : 2_000) + settled, tokens: { input: 100, output: 100, total: 200 } },
    });
  }
  const window = state.window;
  return state.revision + settled + (window ? window.acks + window.losses + Math.floor(window.cwnd) : 0);
}

export const coreWorkloads = {
  cron: runCronWorkload,
  loopReducer: runLoopReducerWorkload,
  taskReducer: runTaskReducerWorkload,
  workflow: runWorkflowWorkload,
  storeReads: runStoreReadWorkload,
  progressPanel: runProgressPanelWorkload,
  orchestration: runOrchestrationWorkload,
} as const;
