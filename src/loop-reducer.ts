import type { DynamicLoopState, LoopEntry, Trigger, WorkflowDefinition } from "./types.js";
import { createWorkflowRun, transitionWorkflowRun } from "./workflow-reducer.js";

export const MAX_LOOP_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Whether a loop has reached its fire cap. Single source of truth for the
 * `maxFires` check shared by the fire callbacks (`onLoopFire` pre-fire guard and
 * `TriggerSystem.fireLoop` post-fire cleanup). Each caller keeps its own timing;
 * only the predicate is shared.
 */
export function atMaxFires(loop: Pick<LoopEntry, "maxFires" | "fireCount">): boolean {
  return !!loop.maxFires && (loop.fireCount ?? 0) >= loop.maxFires;
}

type ReducerSource = "tool" | "command" | "scheduler" | "eventbus" | "monitor" | "session" | "coordinator" | "system";

export interface LoopReducerState {
  nextId: number;
  loopsById: Record<string, LoopEntry>;
}

export type LoopReducerEvent =
  | {
    type: "LOOP_CREATED";
    at: number;
    source: ReducerSource;
    entityType?: "loop";
    entityId?: string;
    payload: {
      prompt: string;
      trigger: Trigger;
      recurring: boolean;
      autoTask?: boolean;
      taskBacklog?: boolean;
      readOnly?: boolean;
      maxFires?: number;
      dynamic?: Partial<DynamicLoopState>;
      workflow?: WorkflowDefinition;
    };
  }
  | {
    type:
      | "LOOP_PAUSED"
      | "LOOP_RESUMED"
      | "LOOP_FIRED"
      | "LOOP_DELETED"
      | "LOOP_MAX_FIRES_REACHED"
      | "LOOP_BACKLOG_EMPTY";
    at: number;
    source: ReducerSource;
    entityType?: "loop";
    entityId?: string;
    payload: { id: string };
  }
  | {
    type: "LOOP_EXPIRED";
    at: number;
    source: ReducerSource;
    entityType?: "loop";
    entityId?: string;
    payload: {
      id: string;
      reason: "expires_at" | "resume_event_stale" | "already_completed_monitor";
    };
  }
  | {
    type: "LOOP_DYNAMIC_UPDATED";
    at: number;
    source: ReducerSource;
    entityType?: "loop";
    entityId?: string;
    payload: {
      id: string;
      prompt?: string;
      dynamic: Partial<DynamicLoopState>;
    };
  }
  | {
    type: "LOOP_WORKFLOW_TRANSITION";
    at: number;
    source: ReducerSource;
    entityType?: "loop";
    entityId?: string;
    payload: {
      id: string;
      outcome: string;
      evidence?: string;
      activeTaskId?: string;
    };
  }
  | {
    type: "LOOP_WORKFLOW_TASK_SET";
    at: number;
    source: ReducerSource;
    entityType?: "loop";
    entityId?: string;
    payload: { id: string; taskId?: string };
  };

export type LoopReducerEffect =
  | {
    type: "PERSIST_LOOP";
    entityType: "loop";
    entityId: string;
    payload: { loop: LoopEntry };
  }
  | {
    type: "DELETE_LOOP";
    entityType: "loop";
    entityId: string;
    payload: { id: string };
  };

export interface LoopReduceResult {
  state: LoopReducerState;
  effects: LoopReducerEffect[];
}

function cloneState(state: LoopReducerState): LoopReducerState {
  return {
    nextId: state.nextId,
    loopsById: { ...state.loopsById },
  };
}

export function reduceLoopState(state: LoopReducerState, event: LoopReducerEvent): LoopReduceResult {
  if (event.type === "LOOP_CREATED") {
    const next = cloneState(state);
    const id = String(next.nextId++);
    const loop: LoopEntry = {
      id,
      prompt: event.payload.prompt,
      trigger: event.payload.trigger,
      status: "active",
      recurring: event.payload.recurring,
      createdAt: event.at,
      updatedAt: event.at,
      expiresAt: event.at + MAX_LOOP_EXPIRY_MS,
      autoTask: event.payload.autoTask,
      taskBacklog: event.payload.taskBacklog,
      readOnly: event.payload.readOnly,
      maxFires: event.payload.maxFires,
      fireCount: 0,
      dynamic: event.payload.trigger.type === "dynamic" || event.payload.dynamic
        ? {
            goal: event.payload.dynamic?.goal ?? event.payload.prompt,
            state: event.payload.dynamic?.state,
            metrics: event.payload.dynamic?.metrics,
            doneCriteria: event.payload.dynamic?.doneCriteria,
            iteration: event.payload.dynamic?.iteration ?? 0,
            nextWakeAt: event.payload.dynamic?.nextWakeAt,
            awaitingUpdate: event.payload.dynamic?.awaitingUpdate ?? false,
            lastUpdatedAt: event.payload.dynamic?.lastUpdatedAt ?? event.at,
          }
        : undefined,
      workflow: event.payload.workflow ? createWorkflowRun(event.payload.workflow, event.at) : undefined,
    };
    next.loopsById[id] = loop;
    return {
      state: next,
      effects: [{ type: "PERSIST_LOOP", entityType: "loop", entityId: id, payload: { loop } }],
    };
  }

  const id = event.payload.id;
  const current = state.loopsById[id];
  if (!current) return { state, effects: [] };

  if (
    event.type === "LOOP_DELETED"
    || event.type === "LOOP_MAX_FIRES_REACHED"
    || event.type === "LOOP_EXPIRED"
    || event.type === "LOOP_BACKLOG_EMPTY"
  ) {
    const next = cloneState(state);
    delete next.loopsById[id];
    return {
      state: next,
      effects: [{ type: "DELETE_LOOP", entityType: "loop", entityId: id, payload: { id } }],
    };
  }

  const next = cloneState(state);
  const loop: LoopEntry = { ...current };

  if (event.type === "LOOP_PAUSED") {
    loop.status = "paused";
    loop.updatedAt = event.at;
  }

  if (event.type === "LOOP_RESUMED") {
    loop.status = "active";
    loop.updatedAt = event.at;
  }

  if (event.type === "LOOP_FIRED") {
    loop.fireCount = (loop.fireCount ?? 0) + 1;
    loop.updatedAt = event.at;
  }

  if (event.type === "LOOP_DYNAMIC_UPDATED") {
    loop.prompt = event.payload.prompt ?? loop.prompt;
    loop.dynamic = {
      goal: event.payload.dynamic.goal ?? loop.dynamic?.goal ?? loop.prompt,
      state: event.payload.dynamic.state ?? loop.dynamic?.state,
      metrics: event.payload.dynamic.metrics ?? loop.dynamic?.metrics,
      doneCriteria: event.payload.dynamic.doneCriteria ?? loop.dynamic?.doneCriteria,
      iteration: event.payload.dynamic.iteration ?? loop.dynamic?.iteration ?? 0,
      nextWakeAt: "nextWakeAt" in event.payload.dynamic ? event.payload.dynamic.nextWakeAt : loop.dynamic?.nextWakeAt,
      awaitingUpdate: event.payload.dynamic.awaitingUpdate ?? loop.dynamic?.awaitingUpdate ?? false,
      lastUpdatedAt: event.payload.dynamic.lastUpdatedAt ?? event.at,
    };
    loop.updatedAt = event.at;
  }

  if (event.type === "LOOP_WORKFLOW_TRANSITION") {
    if (!loop.workflow) return { state, effects: [] };
    const result = transitionWorkflowRun(loop.workflow, {
      outcome: event.payload.outcome,
      evidence: event.payload.evidence,
      activeTaskId: event.payload.activeTaskId,
    }, event.at);
    if (!result.applied) return { state, effects: [] };
    loop.workflow = result.run;
    loop.dynamic = {
      goal: loop.dynamic?.goal ?? loop.prompt,
      state: result.run.currentState,
      metrics: loop.dynamic?.metrics,
      doneCriteria: loop.dynamic?.doneCriteria,
      iteration: (loop.dynamic?.iteration ?? 0) + 1,
      nextWakeAt: undefined,
      awaitingUpdate: false,
      lastUpdatedAt: event.at,
    };
    loop.updatedAt = event.at;
  }

  if (event.type === "LOOP_WORKFLOW_TASK_SET") {
    if (!loop.workflow) return { state, effects: [] };
    loop.workflow = { ...loop.workflow, activeTaskId: event.payload.taskId };
    loop.updatedAt = event.at;
  }

  next.loopsById[id] = loop;
  return {
    state: next,
    effects: [{ type: "PERSIST_LOOP", entityType: "loop", entityId: id, payload: { loop } }],
  };
}
