import { cronToNextFire } from "../src/loop-parse.js";
import { type LoopReducerEvent, type LoopReducerState, reduceLoopState } from "../src/loop-reducer.js";
import { LoopStore } from "../src/store.js";
import { reduceTaskState, type TaskReducerEvent, type TaskReducerState } from "../src/task-reducer.js";
import { TaskStore } from "../src/task-store.js";
import type { WorkflowDefinition } from "../src/types.js";
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

export const coreWorkloads = {
  cron: runCronWorkload,
  loopReducer: runLoopReducerWorkload,
  taskReducer: runTaskReducerWorkload,
  workflow: runWorkflowWorkload,
  storeReads: runStoreReadWorkload,
} as const;
