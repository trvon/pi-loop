import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TaskClaimInput, TaskClaimResult, TaskStore } from "../task-store.js";
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
  claimId?: string;
}

type TaskMutationRejectionCode =
  | "not_found"
  | "no_changes"
  | "claim_required"
  | "claim_missing"
  | "claim_mismatch"
  | "claim_expired"
  | "mutation_conflict"
  | "invalid_transition"
  | "terminal";

type TaskMutationOutcome =
  | { applied: true; entry: TaskEntry; backlog: TaskBacklogResult; idempotent?: boolean }
  | {
      applied: false;
      code: TaskMutationRejectionCode;
      entry?: TaskEntry;
      fromStatus?: TaskStatus;
      toStatus?: TaskStatus;
    };

export function taskMutationRejectionMessage(id: string, result: Extract<TaskMutationOutcome, { applied: false }>): string {
  if (result.code === "not_found") return `Task #${id} not found`;
  if (result.code === "no_changes") return "No update fields were provided.";
  if (result.code === "claim_required") return `Task #${id} has a live claim; claimId is required.`;
  if (result.code === "claim_missing") return `Task #${id} has no live claim; claim the task before sending a heartbeat.`;
  if (result.code === "claim_mismatch") return "Claim token does not match the live task owner.";
  if (result.code === "claim_expired") return `Task #${id} claim lease expired; reclaim the task before modifying it.`;
  if (result.code === "terminal") return `Task #${id} is ${result.entry?.status}; terminal tasks cannot renew claims.`;
  if (result.code === "mutation_conflict") return `Task #${id} changed while the update was applied; refresh it and retry.`;
  return `Transition from ${result.fromStatus} to ${result.toStatus} is not allowed.`;
}

function claimRejection(entry: TaskEntry, claimId: string | undefined, now: number): TaskMutationRejectionCode | undefined {
  if (!entry.claim) return undefined;
  if (entry.claim.leaseExpiresAt <= now) return "claim_expired";
  if (!claimId) return "claim_required";
  if (entry.claim.claimId !== claimId) return "claim_mismatch";
  return undefined;
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

export async function claimTask(
  ctx: TaskMutationContext,
  params: { id: string; claim: TaskClaimInput },
): Promise<{ result: TaskClaimResult; backlog: TaskBacklogResult } | undefined> {
  const previous = ctx.taskStore.get(params.id);
  if (!previous) return undefined;
  const result = ctx.taskStore.claim(params.id, params.claim);
  if (!result) return undefined;
  if (!result.renewed) emitNativeTaskEvent(ctx.pi, "tasks:started", result.entry, previous.status);
  const backlog = await settle(ctx);
  return { result, backlog };
}

export function heartbeatTask(
  ctx: TaskMutationContext,
  params: { id: string; claimId: string; leaseMs: number },
): TaskMutationOutcome {
  const current = ctx.taskStore.get(params.id);
  if (!current) return { applied: false, code: "not_found" };
  if (current.status === "completed" || current.status === "closed") {
    return { applied: false, code: "terminal", entry: current };
  }
  if (!current.claim) return { applied: false, code: "claim_missing", entry: current };
  const rejection = claimRejection(current, params.claimId, Date.now());
  if (rejection) return { applied: false, code: rejection, entry: current };
  const entry = ctx.taskStore.heartbeat(params.id, params.claimId, Date.now(), params.leaseMs);
  if (!entry) return { applied: false, code: "mutation_conflict", entry: ctx.taskStore.get(params.id) };
  ctx.updateWidget();
  return { applied: true, entry, backlog: { created: false } };
}

export async function updateTask(
  ctx: TaskMutationContext,
  params: UpdateTaskFields,
): Promise<TaskMutationOutcome> {
  const { id, status, subject, description, claimId } = params;
  let entry = ctx.taskStore.get(id);
  if (!entry) return { applied: false, code: "not_found" };
  if (status === undefined && subject === undefined && description === undefined) {
    return { applied: false, code: "no_changes", entry };
  }

  const previousStatus = entry.status;
  if (status === entry.status && (status === "pending" || status === "in_progress")) {
    if (status === "in_progress" && entry.claim) {
      if (entry.claim.leaseExpiresAt <= Date.now()) return { applied: false, code: "claim_expired", entry };
      if (claimId && entry.claim.claimId !== claimId) return { applied: false, code: "claim_mismatch", entry };
    }
    if (subject === undefined && description === undefined) {
      return { applied: true, entry, backlog: { created: false }, idempotent: true };
    }
  } else if (status === "in_progress") {
    entry = ctx.taskStore.start(id);
    if (entry) emitNativeTaskEvent(ctx.pi, "tasks:started", entry, previousStatus);
  } else if (status === "completed" || status === "closed") {
    const rejection = claimRejection(entry, claimId, Date.now());
    if (rejection) return { applied: false, code: rejection, entry };
    entry = status === "completed" ? ctx.taskStore.complete(id, claimId) : ctx.taskStore.close(id, claimId);
    if (entry) emitNativeTaskEvent(ctx.pi, status === "completed" ? "tasks:completed" : "tasks:closed", entry, previousStatus);
  } else if (status === "pending") {
    entry = ctx.taskStore.reopen(id);
    if (entry) emitNativeTaskEvent(ctx.pi, "tasks:reopened", entry, previousStatus);
  }
  if (!entry) {
    const current = ctx.taskStore.get(id);
    const lateClaimRejection = current && (status === "in_progress" || status === "completed" || status === "closed")
      ? claimRejection(current, claimId, Date.now())
      : undefined;
    if (current && lateClaimRejection) return { applied: false, code: lateClaimRejection, entry: current };
    const transitionStillValid = current && (
      (status === "in_progress" && current.status === "pending")
      || ((status === "completed" || status === "closed") && (current.status === "pending" || current.status === "in_progress"))
      || (status === "pending" && (current.status === "completed" || current.status === "closed"))
    );
    return current
      ? {
          applied: false,
          code: transitionStillValid ? "mutation_conflict" : "invalid_transition",
          entry: current,
          fromStatus: current.status,
          toStatus: status,
        }
      : { applied: false, code: "not_found" };
  }

  if (subject !== undefined || description !== undefined) {
    const statusAtEdit = entry.status;
    entry = ctx.taskStore.updateDetails(id, { subject, description });
    if (entry) emitNativeTaskEvent(ctx.pi, "tasks:updated", entry, statusAtEdit);
  }
  if (!entry) return { applied: false, code: "not_found" };

  const backlog = await settle(ctx);
  return { applied: true, entry, backlog };
}

export async function deleteTask(
  ctx: TaskMutationContext,
  params: { id: string; claimId?: string },
): Promise<TaskMutationOutcome> {
  const existing = ctx.taskStore.get(params.id);
  if (!existing) return { applied: false, code: "not_found" };
  const rejection = claimRejection(existing, params.claimId, Date.now());
  if (rejection) return { applied: false, code: rejection, entry: existing };
  if (!ctx.taskStore.delete(params.id, params.claimId)) {
    const current = ctx.taskStore.get(params.id);
    if (!current) return { applied: false, code: "not_found" };
    const lateClaimRejection = claimRejection(current, params.claimId, Date.now());
    return lateClaimRejection
      ? { applied: false, code: lateClaimRejection, entry: current }
      : { applied: false, code: "mutation_conflict", entry: current };
  }
  emitNativeTaskEvent(ctx.pi, "tasks:deleted", existing, existing.status);
  const backlog = await settle(ctx);
  return { applied: true, entry: existing, backlog };
}

export async function cleanTasks(ctx: TaskMutationContext): Promise<number> {
  const pruned = ctx.taskStore.pruneCompleted();
  await settle(ctx);
  return pruned;
}
