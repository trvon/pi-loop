import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TaskEntry, TaskStatus, TaskWorkflowLink } from "../task-types.js";

export type NativeTaskEventName =
  | "tasks:created"
  | "tasks:started"
  | "tasks:completed"
  | "tasks:reopened"
  | "tasks:updated"
  | "tasks:deleted";

export interface NativeTaskEventPayload {
  taskId: string;
  subject: string;
  description: string;
  status: TaskStatus;
  previousStatus?: TaskStatus;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  metadata?: Record<string, unknown>;
  workflow?: TaskWorkflowLink;
}

export function emitNativeTaskEvent(
  pi: ExtensionAPI,
  name: NativeTaskEventName,
  entry: TaskEntry,
  previousStatus?: TaskStatus,
): void {
  pi.events.emit(name, {
    taskId: entry.id,
    subject: entry.subject,
    description: entry.description,
    status: entry.status,
    previousStatus,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    completedAt: entry.completedAt,
    metadata: entry.metadata,
    workflow: entry.workflow,
  } satisfies NativeTaskEventPayload);
}
