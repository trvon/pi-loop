import type { ReducerEffect, ReducerEvent } from "./coordinator.js";

export type TaskBacklogEvent = ReducerEvent<
  "TASK_BACKLOG_EVALUATED",
  { pendingCount: number; threshold: number }
>;

export type TaskBacklogEffect =
  | ReducerEffect<"ENSURE_AUTO_TASK_WORKER", { pendingCount: number; threshold: number }>
  | ReducerEffect<"CLEANUP_TASK_BACKLOG_LOOPS", { pendingCount: number }>;

export function reduceTaskBacklogEvent(event: TaskBacklogEvent): TaskBacklogEffect[] {
  if (event.type !== "TASK_BACKLOG_EVALUATED") return [];

  const { pendingCount, threshold } = event.payload;
  if (pendingCount < 0) return [];
  if (pendingCount === 0) {
    return [{
      type: "CLEANUP_TASK_BACKLOG_LOOPS",
      entityType: "task",
      payload: { pendingCount },
    }];
  }
  if (pendingCount >= threshold) {
    return [{
      type: "ENSURE_AUTO_TASK_WORKER",
      entityType: "task",
      payload: { pendingCount, threshold },
    }];
  }
  return [];
}
