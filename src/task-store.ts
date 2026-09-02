import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { ReducerBackedStore } from "./reducer-backed-store.js";
import { reduceTaskState, type TaskReducerEvent, type TaskReducerState } from "./task-reducer.js";
import type { TaskClaim, TaskEntry, TaskStoreData } from "./task-types.js";

const TASKS_DIR = join(homedir(), ".pi", "tasks");
const MAX_TASKS = 200;

const MAX_TASK_LEASE_MS = 60 * 60 * 1000;

export interface TaskClaimInput {
  claimId?: string;
  ownerSessionId: string;
  ownerRuntimeId: string;
  now?: number;
  leaseMs: number;
}

export interface TaskClaimResult {
  entry: TaskEntry;
  claim: TaskClaim;
  takenOver: boolean;
  renewed: boolean;
}

export class TaskStore extends ReducerBackedStore<TaskEntry, TaskReducerState, TaskReducerEvent, TaskStoreData> {
  constructor(listIdOrPath?: string) {
    super(
      {
        baseDir: TASKS_DIR,
        reduce: (state, event) => reduceTaskState(state, event),
        toReducerState: (nextId, entries) => ({ nextId, tasksById: Object.fromEntries(entries.entries()) }),
        fromReducerState: (state) => ({ nextId: state.nextId, entries: new Map(Object.entries(state.tasksById)) }),
        serialize: (nextId, entries) => ({ nextId, tasks: Array.from(entries.values()) }),
        deserialize: (data) => ({ nextId: data.nextId, entries: new Map(data.tasks.map((t) => [t.id, t])) }),
      },
      listIdOrPath,
    );
  }

  create(subject: string, description: string, metadata?: Record<string, unknown>): TaskEntry {
    return this.withLock(() => {
      if (this.entries.size >= MAX_TASKS) {
        throw new Error(`Maximum of ${MAX_TASKS} tasks reached. Delete some before creating new ones.`);
      }
      const now = Date.now();
      this.applyReducerEvent({
        type: "TASK_CREATED",
        at: now,
        source: "tool",
        entityType: "task",
        payload: { subject, description, metadata },
      });
      return this.entries.get(String(this.nextId - 1))!;
    });
  }

  claim(id: string, input: TaskClaimInput): TaskClaimResult | undefined {
    if (!input.ownerSessionId || !input.ownerRuntimeId || !Number.isSafeInteger(input.leaseMs)
      || input.leaseMs <= 0 || input.leaseMs > MAX_TASK_LEASE_MS) {
      return undefined;
    }
    return this.withLock(() => {
      const current = this.entries.get(id);
      if (!current || current.status === "completed" || current.status === "closed") return undefined;
      const now = input.now ?? Date.now();
      const existing = current.claim;
      const existingIsLive = existing !== undefined && existing.leaseExpiresAt > now;
      const sameLiveOwner = existingIsLive
        && existing.ownerSessionId === input.ownerSessionId
        && existing.ownerRuntimeId === input.ownerRuntimeId;
      if (existingIsLive && !sameLiveOwner) return undefined;

      const takenOver = current.status === "in_progress" && existing !== undefined
        && (existing.ownerSessionId !== input.ownerSessionId || existing.ownerRuntimeId !== input.ownerRuntimeId);
      const claim: TaskClaim = sameLiveOwner && existing
        ? {
            ...existing,
            heartbeatAt: now,
            leaseExpiresAt: now + input.leaseMs,
          }
        : {
            claimId: input.claimId ?? randomUUID(),
            ownerSessionId: input.ownerSessionId,
            ownerRuntimeId: input.ownerRuntimeId,
            claimedAt: now,
            heartbeatAt: now,
            leaseExpiresAt: now + input.leaseMs,
            attempt: (existing?.attempt ?? 0) + 1,
          };
      const entry: TaskEntry = {
        ...current,
        status: "in_progress",
        updatedAt: now,
        revision: (current.revision ?? 0) + 1,
        claim,
      };
      this.entries.set(id, entry);
      return { entry, claim, takenOver, renewed: sameLiveOwner };
    });
  }

  heartbeat(id: string, claimId: string, now = Date.now(), leaseMs = 30 * 60 * 1000): TaskEntry | undefined {
    if (!claimId || !Number.isSafeInteger(leaseMs) || leaseMs <= 0 || leaseMs > MAX_TASK_LEASE_MS) return undefined;
    return this.withLock(() => {
      const current = this.entries.get(id);
      if (!current?.claim
        || current.claim.claimId !== claimId
        || current.claim.leaseExpiresAt <= now
        || current.status !== "in_progress") {
        return undefined;
      }
      const entry: TaskEntry = {
        ...current,
        updatedAt: now,
        revision: (current.revision ?? 0) + 1,
        claim: {
          ...current.claim,
          heartbeatAt: now,
          leaseExpiresAt: now + leaseMs,
        },
      };
      this.entries.set(id, entry);
      return entry;
    });
  }

  start(id: string): TaskEntry | undefined {
    return this.withLock(() => {
      const entry = this.entries.get(id);
      if (!entry || entry.status === "completed" || entry.status === "closed" || entry.claim) return undefined;
      this.applyReducerEvent({
        type: "TASK_STARTED",
        at: Date.now(),
        source: "tool",
        entityType: "task",
        entityId: id,
        payload: { id },
      });
      return this.entries.get(id);
    });
  }

  complete(id: string, claimId?: string, now = Date.now()): TaskEntry | undefined {
    return this.withLock(() => {
      const entry = this.entries.get(id);
      if (!entry
        || (entry.status !== "pending" && entry.status !== "in_progress")
        || (entry.claim && (entry.claim.claimId !== claimId || entry.claim.leaseExpiresAt <= now))) {
        return undefined;
      }
      this.applyReducerEvent({
        type: "TASK_COMPLETED",
        at: now,
        source: "tool",
        entityType: "task",
        entityId: id,
        payload: { id },
      });
      return this.entries.get(id);
    });
  }

  close(id: string, claimId?: string, now = Date.now()): TaskEntry | undefined {
    return this.withLock(() => {
      const entry = this.entries.get(id);
      if (!entry
        || (entry.status !== "pending" && entry.status !== "in_progress")
        || (entry.claim && (entry.claim.claimId !== claimId || entry.claim.leaseExpiresAt <= now))) {
        return undefined;
      }
      this.applyReducerEvent({
        type: "TASK_CLOSED",
        at: now,
        source: "tool",
        entityType: "task",
        entityId: id,
        payload: { id },
      });
      return this.entries.get(id);
    });
  }

  reopen(id: string): TaskEntry | undefined {
    return this.withLock(() => {
      const entry = this.entries.get(id);
      if (!entry || (entry.status !== "completed" && entry.status !== "closed")) return undefined;
      this.applyReducerEvent({
        type: "TASK_REOPENED",
        at: Date.now(),
        source: "tool",
        entityType: "task",
        entityId: id,
        payload: { id },
      });
      return this.entries.get(id);
    });
  }

  updateDetails(
    id: string,
    fields: { subject?: string; description?: string },
    options: { claimId?: string; expectedRevision?: number; now?: number } = {},
  ): TaskEntry | undefined {
    return this.withLock(() => {
      const entry = this.entries.get(id);
      if (!entry) return undefined;
      const now = options.now ?? Date.now();
      if (options.expectedRevision !== undefined && entry.revision !== options.expectedRevision) return undefined;
      if (entry.claim && (
        entry.claim.leaseExpiresAt <= now
        || !options.claimId
        || entry.claim.claimId !== options.claimId
      )) return undefined;
      if (fields.subject === undefined && fields.description === undefined) return entry;
      this.applyReducerEvent({
        type: "TASK_UPDATED",
        at: now,
        source: "tool",
        entityType: "task",
        entityId: id,
        payload: {
          id,
          subject: fields.subject,
          description: fields.description,
        },
      });
      return this.entries.get(id);
    });
  }

  delete(id: string, claimId?: string, now = Date.now()): boolean {
    return this.withLock(() => {
      const entry = this.entries.get(id);
      if (!entry
        || (entry.claim && (entry.claim.claimId !== claimId || entry.claim.leaseExpiresAt <= now))) {
        return false;
      }
      this.applyReducerEvent({
        type: "TASK_DELETED",
        at: Date.now(),
        source: "tool",
        entityType: "task",
        entityId: id,
        payload: { id },
      });
      return true;
    });
  }

  pendingCount(): number {
    let count = 0;
    for (const t of this.entries.values()) {
      if (t.status === "pending" || t.status === "in_progress") count++;
    }
    return count;
  }

  pruneCompleted(): number {
    return this.withLock(() => {
      const before = this.entries.size;
      this.applyReducerEvent({
        type: "TASKS_PRUNED",
        at: Date.now(),
        source: "system",
        entityType: "task",
        payload: { reason: "manual" },
      });
      return before - this.entries.size;
    });
  }
}
