import { homedir } from "node:os";
import { join } from "node:path";
import { ReducerBackedStore } from "./reducer-backed-store.js";
import { reduceTaskState, type TaskReducerEvent, type TaskReducerState } from "./task-reducer.js";
import type { TaskEntry, TaskStoreData } from "./task-types.js";

const TASKS_DIR = join(homedir(), ".pi", "tasks");
const MAX_TASKS = 200;

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

  start(id: string): TaskEntry | undefined {
    return this.withLock(() => {
      const entry = this.entries.get(id);
      if (!entry) return undefined;
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

  complete(id: string): TaskEntry | undefined {
    return this.withLock(() => {
      const entry = this.entries.get(id);
      if (!entry) return undefined;
      this.applyReducerEvent({
        type: "TASK_COMPLETED",
        at: Date.now(),
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
      if (!entry) return undefined;
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

  updateDetails(id: string, fields: { subject?: string; description?: string }): TaskEntry | undefined {
    return this.withLock(() => {
      const entry = this.entries.get(id);
      if (!entry) return undefined;
      if (fields.subject === undefined && fields.description === undefined) return entry;
      this.applyReducerEvent({
        type: "TASK_UPDATED",
        at: Date.now(),
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

  delete(id: string): boolean {
    return this.withLock(() => {
      if (!this.entries.has(id)) return false;
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
