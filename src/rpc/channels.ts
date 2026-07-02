// VENDORED MODULE — canonical copy shared verbatim by pi-loop and pi-orca.
// If you edit this file, copy it to the sibling repo and bump VENDOR_REV.
// VENDOR_REV: 1

/** Cross-extension RPC channels served by a tasks provider (pi-tasks or pi-loop native). */
export const TASKS_RPC = {
  ping: "tasks:rpc:ping",
  create: "tasks:rpc:create",
  update: "tasks:rpc:update",
  pending: "tasks:rpc:pending",
  clean: "tasks:rpc:clean",
} as const;

/** Cross-extension RPC channels served by @tintinweb/pi-subagents. */
export const SUBAGENTS_RPC = {
  ping: "subagents:rpc:ping",
  spawn: "subagents:rpc:spawn",
  stop: "subagents:rpc:stop",
} as const;

/** Broadcast (fire-and-forget) task lifecycle events. */
export const TASK_EVENTS = {
  ready: "tasks:ready",
  created: "tasks:created",
  started: "tasks:started",
  completed: "tasks:completed",
  reopened: "tasks:reopened",
  updated: "tasks:updated",
  deleted: "tasks:deleted",
} as const;

export function replyChannel(channel: string, requestId: string): string {
  return `${channel}:reply:${requestId}`;
}

// ── Wire-level DTOs ──
// Structural: pi-loop's TaskEntry satisfies TaskEntryWire; consumers on the
// other side of the bus depend only on these shapes, never on store internals.

export type TaskStatusWire = "pending" | "in_progress" | "completed";

export interface TaskEntryWire {
  id: string;
  subject: string;
  description: string;
  status: TaskStatusWire;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  metadata?: Record<string, unknown>;
}

export interface CreateTaskParams {
  subject: string;
  description: string;
  metadata?: Record<string, unknown>;
}

export interface CreateTaskReply {
  id: string;
  task: TaskEntryWire;
}

export interface UpdateTaskParams {
  id: string;
  status?: TaskStatusWire;
  subject?: string;
  description?: string;
}

export interface UpdateTaskReply {
  task: TaskEntryWire;
}

export interface PendingReply {
  pending: number;
}

export interface CleanReply {
  pruned: number;
}

export interface PingReply {
  version: number;
  /** Identifies which extension answered; lets a provider ignore its own reply. */
  provider?: string;
}

export interface SpawnParams {
  type: string;
  prompt: string;
  options?: Record<string, unknown>;
}

export interface SpawnReply {
  id: string;
}
