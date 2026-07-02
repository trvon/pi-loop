import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TaskStore } from "../task-store.js";
import type { TaskEntry, TaskStatus } from "../task-types.js";
import { emitNativeTaskEvent } from "./task-events.js";

export interface TaskBacklogResult {
  created: boolean;
  entry?: { id: string };
  cleaned?: number;
}

export interface TaskMutationContext {
  pi: ExtensionAPI;
  taskStore: TaskStore;
  evaluateTaskBacklog: (
    taskStore: TaskStore,
    pendingCount: number,
  ) => Promise<TaskBacklogResult>;
  updateWidget: () => void;
}

export interface UpdateTaskFields {
  id: string;
  status?: TaskStatus;
  subject?: string;
  description?: string;
}

/**
 * Single source of truth for native task mutations, shared by the TaskCreate/
 * TaskUpdate/TaskDelete tools and the tasks:rpc:* server so both surfaces emit
 * identical events in one canonical order: mutate → emit → widget → backlog.
 */

async function settle(ctx: TaskMutationContext): Promise<TaskBacklogResult> {
  ctx.updateWidget();
  return await ctx.evaluateTaskBacklog(ctx.taskStore, ctx.taskStore.pendingCount());
}

export async function createTask(
  ctx: TaskMutationContext,
  params: { subject: string; description: string; metadata?: Record<string, unknown> },
): Promise<{ entry: TaskEntry; backlog: TaskBacklogResult }> {
  const entry = ctx.taskStore.create(params.subject, params.description, params.metadata);
  emitNativeTaskEvent(ctx.pi, "tasks:created", entry);
  const backlog = await settle(ctx);
  return { entry, backlog };
}

export async function updateTask(
  ctx: TaskMutationContext,
  params: UpdateTaskFields,
): Promise<{ entry: TaskEntry; backlog: TaskBacklogResult } | undefined> {
  const { id, status, subject, description } = params;
  let entry = ctx.taskStore.get(id);
  if (!entry) return undefined;

  const previousStatus = entry.status;
  if (status === "in_progress") {
    entry = ctx.taskStore.start(id);
    if (entry) emitNativeTaskEvent(ctx.pi, "tasks:started", entry, previousStatus);
  } else if (status === "completed") {
    entry = ctx.taskStore.complete(id);
    if (entry) emitNativeTaskEvent(ctx.pi, "tasks:completed", entry, previousStatus);
  } else if (status === "pending") {
    entry = ctx.taskStore.reopen(id);
    if (entry) emitNativeTaskEvent(ctx.pi, "tasks:reopened", entry, previousStatus);
  }
  if (!entry) return undefined;

  if (subject !== undefined || description !== undefined) {
    // A details edit is not a transition: its previousStatus is the status
    // current at edit time (i.e. after any transition above), so consumers
    // never see a fabricated second transition.
    const statusAtEdit = entry.status;
    entry = ctx.taskStore.updateDetails(id, { subject, description });
    if (entry) emitNativeTaskEvent(ctx.pi, "tasks:updated", entry, statusAtEdit);
  }
  if (!entry) return undefined;

  const backlog = await settle(ctx);
  return { entry, backlog };
}

export async function deleteTask(
  ctx: TaskMutationContext,
  id: string,
): Promise<{ entry: TaskEntry; backlog: TaskBacklogResult } | undefined> {
  const existing = ctx.taskStore.get(id);
  if (!existing || !ctx.taskStore.delete(id)) {
    ctx.updateWidget();
    return undefined;
  }
  emitNativeTaskEvent(ctx.pi, "tasks:deleted", existing, existing.status);
  const backlog = await settle(ctx);
  return { entry: existing, backlog };
}

export async function cleanTasks(ctx: TaskMutationContext): Promise<number> {
  const pruned = ctx.taskStore.pruneCompleted();
  await settle(ctx);
  return pruned;
}
