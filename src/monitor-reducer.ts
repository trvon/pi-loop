import type { MonitorEntry } from "./types.js";

type ReducerSource = "tool" | "command" | "scheduler" | "eventbus" | "monitor" | "session" | "coordinator" | "system";

export interface MonitorReducerEntry extends MonitorEntry {
  onDoneRegistered?: boolean;
}

export interface MonitorReducerState {
  nextId: number;
  monitorsById: Record<string, MonitorReducerEntry>;
}

export type MonitorReducerEvent =
  | {
    type: "MONITOR_CREATED";
    at: number;
    source: ReducerSource;
    entityType?: "monitor";
    entityId?: string;
    payload: {
      command: string;
      description?: string;
      timeout: number;
    };
  }
  | {
    type: "MONITOR_OUTPUT";
    at: number;
    source: ReducerSource;
    entityType?: "monitor";
    entityId?: string;
    payload: {
      id: string;
      line: string;
    };
  }
  | {
    type: "MONITOR_COMPLETED" | "MONITOR_ERRORED";
    at: number;
    source: ReducerSource;
    entityType?: "monitor";
    entityId?: string;
    payload: {
      id: string;
      exitCode?: number;
      error?: string;
    };
  }
  | {
    type: "MONITOR_STOPPED";
    at: number;
    source: ReducerSource;
    entityType?: "monitor";
    entityId?: string;
    payload: {
      id: string;
      reason: "manual" | "timeout";
    };
  }
  | {
    type: "MONITOR_PRUNED" | "MONITOR_ONDONE_REGISTERED";
    at: number;
    source: ReducerSource;
    entityType?: "monitor";
    entityId?: string;
    payload: {
      id: string;
    };
  };

export type MonitorReducerEffect =
  | {
    type: "PERSIST_MONITOR";
    entityType: "monitor";
    entityId: string;
    payload: { monitor: MonitorReducerEntry };
  }
  | {
    type: "DELETE_MONITOR";
    entityType: "monitor";
    entityId: string;
    payload: { id: string };
  };

export interface MonitorReduceResult {
  state: MonitorReducerState;
  effects: MonitorReducerEffect[];
}

function cloneState(state: MonitorReducerState): MonitorReducerState {
  return {
    nextId: state.nextId,
    monitorsById: { ...state.monitorsById },
  };
}

export function reduceMonitorState(state: MonitorReducerState, event: MonitorReducerEvent): MonitorReduceResult {
  if (event.type === "MONITOR_CREATED") {
    const next = cloneState(state);
    const id = String(next.nextId++);
    const monitor: MonitorReducerEntry = {
      id,
      command: event.payload.command,
      description: event.payload.description,
      timeout: event.payload.timeout,
      status: "running",
      startedAt: event.at,
      outputLines: 0,
      outputBuffer: [],
    };
    next.monitorsById[id] = monitor;
    return {
      state: next,
      effects: [{ type: "PERSIST_MONITOR", entityType: "monitor", entityId: id, payload: { monitor } }],
    };
  }

  const id = event.payload.id;
  const current = state.monitorsById[id];
  if (!current) return { state, effects: [] };

  if (event.type === "MONITOR_PRUNED") {
    const next = cloneState(state);
    delete next.monitorsById[id];
    return {
      state: next,
      effects: [{ type: "DELETE_MONITOR", entityType: "monitor", entityId: id, payload: { id } }],
    };
  }

  const next = cloneState(state);
  const monitor: MonitorReducerEntry = { ...current };

  if (event.type === "MONITOR_OUTPUT") {
    monitor.outputLines++;
    if (monitor.outputBuffer.length < 200) monitor.outputBuffer = [...monitor.outputBuffer, event.payload.line];
  }

  if (event.type === "MONITOR_COMPLETED") {
    monitor.status = "completed";
    monitor.exitCode = event.payload.exitCode;
    monitor.completedAt = event.at;
  }

  if (event.type === "MONITOR_ERRORED") {
    monitor.status = "error";
    if (event.payload.exitCode !== undefined) monitor.exitCode = event.payload.exitCode;
    monitor.completedAt = event.at;
  }

  if (event.type === "MONITOR_STOPPED") {
    monitor.status = "stopped";
    monitor.completedAt = event.at;
  }

  if (event.type === "MONITOR_ONDONE_REGISTERED") {
    monitor.onDoneRegistered = true;
  }

  next.monitorsById[id] = monitor;
  return {
    state: next,
    effects: [{ type: "PERSIST_MONITOR", entityType: "monitor", entityId: id, payload: { monitor } }],
  };
}
