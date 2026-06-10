import type { LoopEntry, Trigger } from "./types.js";

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

  next.loopsById[id] = loop;
  return {
    state: next,
    effects: [{ type: "PERSIST_LOOP", entityType: "loop", entityId: id, payload: { loop } }],
  };
}
