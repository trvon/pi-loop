import type { LoopEntry } from "../types.js";

export type LoopAutoDeleteReason = "task_backlog_empty";

export interface LoopAutodeletedPayload {
  loopId: string;
  prompt: string;
  trigger: LoopEntry["trigger"];
  recurring: boolean;
  autoTask?: boolean;
  taskBacklog?: boolean;
  readOnly?: boolean;
  maxFires?: number;
  fireCount?: number;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  source: "task_backlog_runtime";
  reason: LoopAutoDeleteReason;
  pendingCount: number;
}

export interface TaskBacklogEmptyPayload {
  pendingCount: 0;
  deletedLoopIds: string[];
  source: "task_backlog_runtime";
}

export function buildLoopAutodeletedPayload(
  entry: LoopEntry,
  pendingCount: number,
): LoopAutodeletedPayload {
  return {
    loopId: entry.id,
    prompt: entry.prompt,
    trigger: entry.trigger,
    recurring: entry.recurring,
    autoTask: entry.autoTask,
    taskBacklog: entry.taskBacklog,
    readOnly: entry.readOnly,
    maxFires: entry.maxFires,
    fireCount: entry.fireCount,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    expiresAt: entry.expiresAt,
    source: "task_backlog_runtime",
    reason: "task_backlog_empty",
    pendingCount,
  };
}

export function buildTaskBacklogEmptyPayload(
  deletedLoopIds: string[],
): TaskBacklogEmptyPayload {
  return {
    pendingCount: 0,
    deletedLoopIds,
    source: "task_backlog_runtime",
  };
}
