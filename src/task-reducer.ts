import type { TaskEntry, TaskWorkflowLink } from "./task-types.js";

export interface TaskReducerState {
  nextId: number;
  tasksById: Record<string, TaskEntry>;
}

export type TaskReducerEvent =
  | {
    type: "TASK_CREATED";
    at: number;
    source: "tool" | "command" | "scheduler" | "eventbus" | "monitor" | "session" | "coordinator" | "system";
    entityType?: "task";
    entityId?: string;
    payload: {
      subject: string;
      description: string;
      metadata?: Record<string, unknown>;
      workflow?: TaskWorkflowLink;
    };
  }
  | {
    type: "TASK_STARTED" | "TASK_COMPLETED" | "TASK_REOPENED" | "TASK_DELETED";
    at: number;
    source: "tool" | "command" | "scheduler" | "eventbus" | "monitor" | "session" | "coordinator" | "system";
    entityType?: "task";
    entityId?: string;
    payload: { id: string };
  }
  | {
    type: "TASK_UPDATED";
    at: number;
    source: "tool" | "command" | "scheduler" | "eventbus" | "monitor" | "session" | "coordinator" | "system";
    entityType?: "task";
    entityId?: string;
    payload: {
      id: string;
      subject?: string;
      description?: string;
    };
  }
  | {
    type: "TASKS_PRUNED";
    at: number;
    source: "tool" | "command" | "scheduler" | "eventbus" | "monitor" | "session" | "coordinator" | "system";
    entityType?: "task";
    entityId?: string;
    payload: {
      reason: "git_commit" | "zero_pending_cleanup" | "manual";
    };
  };

export type TaskReducerEffect =
  | {
    type: "PERSIST_TASK";
    entityType: "task";
    entityId: string;
    payload: { task: TaskEntry };
  }
  | {
    type: "DELETE_TASK";
    entityType: "task";
    entityId: string;
    payload: { id: string };
  };

export interface TaskReduceResult {
  state: TaskReducerState;
  effects: TaskReducerEffect[];
}

function cloneState(state: TaskReducerState): TaskReducerState {
  return {
    nextId: state.nextId,
    tasksById: { ...state.tasksById },
  };
}

export function reduceTaskState(state: TaskReducerState, event: TaskReducerEvent): TaskReduceResult {
  if (event.type === "TASK_CREATED") {
    const next = cloneState(state);
    const id = String(next.nextId++);
    const task: TaskEntry = {
      id,
      subject: event.payload.subject,
      description: event.payload.description,
      status: "pending",
      createdAt: event.at,
      updatedAt: event.at,
      metadata: event.payload.metadata,
      workflow: event.payload.workflow,
    };
    next.tasksById[id] = task;
    return {
      state: next,
      effects: [{ type: "PERSIST_TASK", entityType: "task", entityId: id, payload: { task } }],
    };
  }

  if (event.type === "TASKS_PRUNED") {
    const next = cloneState(state);
    const effects: TaskReducerEffect[] = [];
    for (const [id, task] of Object.entries(next.tasksById)) {
      if (task.status !== "completed") continue;
      delete next.tasksById[id];
      effects.push({ type: "DELETE_TASK", entityType: "task", entityId: id, payload: { id } });
    }
    return { state: next, effects };
  }

  const id = event.payload.id;
  const current = state.tasksById[id];
  if (!current) return { state, effects: [] };

  if (event.type === "TASK_DELETED") {
    const next = cloneState(state);
    delete next.tasksById[id];
    return {
      state: next,
      effects: [{ type: "DELETE_TASK", entityType: "task", entityId: id, payload: { id } }],
    };
  }

  const next = cloneState(state);
  const task: TaskEntry = { ...current };

  if (event.type === "TASK_STARTED") {
    task.status = "in_progress";
    task.updatedAt = event.at;
  }

  if (event.type === "TASK_COMPLETED") {
    task.status = "completed";
    task.updatedAt = event.at;
    task.completedAt = event.at;
  }

  if (event.type === "TASK_REOPENED") {
    task.status = "pending";
    task.updatedAt = event.at;
    // `completedAt` is intentionally retained: it records the most recent
    // completion, not "is currently complete" (use `status` for that). A
    // reopened task keeps the timestamp of when it was last completed.
  }

  if (event.type === "TASK_UPDATED") {
    if (event.payload.subject !== undefined) task.subject = event.payload.subject;
    if (event.payload.description !== undefined) task.description = event.payload.description;
    task.updatedAt = event.at;
  }

  next.tasksById[id] = task;
  return {
    state: next,
    effects: [{ type: "PERSIST_TASK", entityType: "task", entityId: id, payload: { task } }],
  };
}
