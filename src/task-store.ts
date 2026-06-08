import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { reduceTaskState, type TaskReducerEvent, type TaskReducerState } from "./task-reducer.js";
import type { TaskEntry, TaskStatus, TaskStoreData } from "./task-types.js";

const TASKS_DIR = join(homedir(), ".pi", "tasks");
const LOCK_RETRY_MS = 50;
const LOCK_MAX_RETRIES = 100;
const MAX_TASKS = 200;

function acquireLock(lockPath: string): void {
  for (let i = 0; i < LOCK_MAX_RETRIES; i++) {
    try {
      writeFileSync(lockPath, `${process.pid}`, { flag: "wx" });
      return;
    } catch (e: any) {
      if (e.code === "EEXIST") {
        try {
          const pid = parseInt(readFileSync(lockPath, "utf-8"), 10);
          if (!pid || !isProcessRunning(pid)) {
            try { unlinkSync(lockPath); } catch { /* ignore */ }
            continue;
          }
        } catch { /* ignore read errors */ }
        const start = Date.now();
        while (Date.now() - start < LOCK_RETRY_MS) { /* busy wait */ }
        continue;
      }
      throw e;
    }
  }
  throw new Error(`Failed to acquire lock: ${lockPath}`);
}

function releaseLock(lockPath: string): void {
  try { unlinkSync(lockPath); } catch { /* ignore */ }
}

function isProcessRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export class TaskStore {
  private filePath: string | undefined;
  private lockPath: string | undefined;

  private nextId = 1;
  private tasks = new Map<string, TaskEntry>();

  constructor(listIdOrPath?: string) {
    if (!listIdOrPath) return;
    const isAbsPath = isAbsolute(listIdOrPath);
    const filePath = isAbsPath ? listIdOrPath : join(TASKS_DIR, `${listIdOrPath}.json`);
    mkdirSync(dirname(filePath), { recursive: true });
    this.filePath = filePath;
    this.lockPath = filePath + ".lock";
    this.load();
  }

  private load(): void {
    if (!this.filePath) return;
    if (!existsSync(this.filePath)) return;
    try {
      const data: TaskStoreData = JSON.parse(readFileSync(this.filePath, "utf-8"));
      this.nextId = data.nextId;
      this.tasks.clear();
      for (const task of data.tasks) {
        this.tasks.set(task.id, task);
      }
    } catch { /* corrupt file — start fresh */ }
  }

  private save(): void {
    if (!this.filePath) return;
    const data: TaskStoreData = {
      nextId: this.nextId,
      tasks: Array.from(this.tasks.values()),
    };
    const tmpPath = this.filePath + ".tmp";
    writeFileSync(tmpPath, JSON.stringify(data, null, 2));
    renameSync(tmpPath, this.filePath);
  }

  private withLock<T>(fn: () => T): T {
    if (!this.lockPath) return fn();
    acquireLock(this.lockPath);
    try {
      this.load();
      const result = fn();
      this.save();
      return result;
    } finally {
      releaseLock(this.lockPath);
    }
  }

  private toReducerState(): TaskReducerState {
    return {
      nextId: this.nextId,
      tasksById: Object.fromEntries(this.tasks.entries()),
    };
  }

  private applyReducerEvent(event: TaskReducerEvent): void {
    const result = reduceTaskState(this.toReducerState(), event);
    this.nextId = result.state.nextId;
    this.tasks = new Map(Object.entries(result.state.tasksById));
  }

  create(subject: string, description: string, metadata?: Record<string, unknown>): TaskEntry {
    return this.withLock(() => {
      if (this.tasks.size >= MAX_TASKS) {
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
      return this.tasks.get(String(this.nextId - 1))!;
    });
  }

  get(id: string): TaskEntry | undefined {
    if (this.filePath) this.load();
    return this.tasks.get(id);
  }

  list(): TaskEntry[] {
    if (this.filePath) this.load();
    return Array.from(this.tasks.values()).sort((a, b) => Number(a.id) - Number(b.id));
  }

  update(id: string, fields: { status?: TaskStatus; subject?: string; description?: string }): TaskEntry | undefined {
    return this.withLock(() => {
      const entry = this.tasks.get(id);
      if (!entry) return undefined;

      const now = Date.now();
      if (fields.status === "in_progress") {
        this.applyReducerEvent({
          type: "TASK_STARTED",
          at: now,
          source: "tool",
          entityType: "task",
          entityId: id,
          payload: { id },
        });
      } else if (fields.status === "completed") {
        this.applyReducerEvent({
          type: "TASK_COMPLETED",
          at: now,
          source: "tool",
          entityType: "task",
          entityId: id,
          payload: { id },
        });
      } else if (fields.status === "pending") {
        this.applyReducerEvent({
          type: "TASK_REOPENED",
          at: now,
          source: "tool",
          entityType: "task",
          entityId: id,
          payload: { id },
        });
      }

      if (fields.subject !== undefined || fields.description !== undefined) {
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
      }

      return this.tasks.get(id);
    });
  }

  delete(id: string): boolean {
    return this.withLock(() => {
      if (!this.tasks.has(id)) return false;
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
    for (const t of this.tasks.values()) {
      if (t.status === "pending" || t.status === "in_progress") count++;
    }
    return count;
  }

  sweepCompleted(): number {
    return this.withLock(() => {
      const before = this.tasks.size;
      this.applyReducerEvent({
        type: "TASKS_PRUNED",
        at: Date.now(),
        source: "system",
        entityType: "task",
        payload: { reason: "manual" },
      });
      return before - this.tasks.size;
    });
  }
}
