import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { type LoopReducerEvent, type LoopReducerState, reduceLoopState } from "./loop-reducer.js";
import type { LoopEntry, LoopStatus, LoopStoreData, Trigger } from "./types.js";

const LOOPS_DIR = join(homedir(), ".pi", "loops");
const LOCK_RETRY_MS = 50;
const LOCK_MAX_RETRIES = 100;
const MAX_LOOPS = 25;

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

export class LoopStore {
  private filePath: string | undefined;
  private lockPath: string | undefined;

  private nextId = 1;
  private loops = new Map<string, LoopEntry>();

  constructor(listIdOrPath?: string) {
    if (!listIdOrPath) return;
    const isAbsPath = isAbsolute(listIdOrPath);
    const filePath = isAbsPath ? listIdOrPath : join(LOOPS_DIR, `${listIdOrPath}.json`);
    mkdirSync(dirname(filePath), { recursive: true });
    this.filePath = filePath;
    this.lockPath = filePath + ".lock";
    this.load();
  }

  private load(): void {
    if (!this.filePath) return;
    if (!existsSync(this.filePath)) return;
    try {
      const data: LoopStoreData = JSON.parse(readFileSync(this.filePath, "utf-8"));
      this.nextId = data.nextId;
      this.loops.clear();
      for (const loop of data.loops) {
        this.loops.set(loop.id, loop);
      }
    } catch { /* corrupt file — start fresh */ }
  }

  private save(): void {
    if (!this.filePath) return;
    const data: LoopStoreData = {
      nextId: this.nextId,
      loops: Array.from(this.loops.values()),
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

  private toReducerState(): LoopReducerState {
    return {
      nextId: this.nextId,
      loopsById: Object.fromEntries(this.loops.entries()),
    };
  }

  private applyReducerEvent(event: LoopReducerEvent): void {
    const result = reduceLoopState(this.toReducerState(), event);
    this.nextId = result.state.nextId;
    this.loops = new Map(Object.entries(result.state.loopsById));
  }

  create(trigger: Trigger, prompt: string, opts: { recurring: boolean; autoTask?: boolean; taskBacklog?: boolean; readOnly?: boolean; maxFires?: number }): LoopEntry {
    return this.withLock(() => {
      if (this.loops.size >= MAX_LOOPS) {
        throw new Error(`Maximum of ${MAX_LOOPS} loops reached. Delete some before creating new ones.`);
      }
      const now = Date.now();
      this.applyReducerEvent({
        type: "LOOP_CREATED",
        at: now,
        source: "tool",
        entityType: "loop",
        payload: {
          prompt,
          trigger,
          recurring: opts.recurring,
          autoTask: opts.autoTask,
          taskBacklog: opts.taskBacklog,
          readOnly: opts.readOnly,
          maxFires: opts.maxFires,
        },
      });
      return this.loops.get(String(this.nextId - 1))!;
    });
  }

  get(id: string): LoopEntry | undefined {
    if (this.filePath) this.load();
    return this.loops.get(id);
  }

  list(): LoopEntry[] {
    if (this.filePath) this.load();
    return Array.from(this.loops.values()).sort((a, b) => Number(a.id) - Number(b.id));
  }

  update(id: string, fields: { status?: LoopStatus; trigger?: Trigger; prompt?: string; fireCount?: number }): { entry: LoopEntry | undefined; changedFields: string[] } {
    return this.withLock(() => {
      const entry = this.loops.get(id);
      if (!entry) return { entry: undefined, changedFields: [] };

      const changedFields: string[] = [];
      const now = Date.now();

      if (fields.status === "paused") {
        this.applyReducerEvent({
          type: "LOOP_PAUSED",
          at: now,
          source: "tool",
          entityType: "loop",
          entityId: id,
          payload: { id },
        });
        changedFields.push("status");
      } else if (fields.status === "active") {
        this.applyReducerEvent({
          type: "LOOP_RESUMED",
          at: now,
          source: "tool",
          entityType: "loop",
          entityId: id,
          payload: { id },
        });
        changedFields.push("status");
      }

      const current = this.loops.get(id);
      if (!current) return { entry: undefined, changedFields };

      if (fields.trigger !== undefined) {
        current.trigger = fields.trigger;
        changedFields.push("trigger");
      }
      if (fields.prompt !== undefined) {
        current.prompt = fields.prompt;
        changedFields.push("prompt");
      }
      if (fields.fireCount !== undefined) {
        if (fields.fireCount === (current.fireCount ?? 0) + 1) {
          this.applyReducerEvent({
            type: "LOOP_FIRED",
            at: now,
            source: "system",
            entityType: "loop",
            entityId: id,
            payload: { id },
          });
        } else {
          current.fireCount = fields.fireCount;
          current.updatedAt = now;
        }
        changedFields.push("fireCount");
      }

      if (fields.trigger !== undefined || fields.prompt !== undefined) {
        current.updatedAt = now;
      }

      return { entry: this.loops.get(id), changedFields };
    });
  }

  delete(id: string): boolean {
    return this.withLock(() => {
      if (!this.loops.has(id)) return false;
      this.applyReducerEvent({
        type: "LOOP_DELETED",
        at: Date.now(),
        source: "tool",
        entityType: "loop",
        entityId: id,
        payload: { id },
      });
      return true;
    });
  }

  clearExpired(): number {
    return this.withLock(() => {
      const now = Date.now();
      let count = 0;
      for (const [id, entry] of [...this.loops.entries()]) {
        if (now < entry.expiresAt) continue;
        this.applyReducerEvent({
          type: "LOOP_EXPIRED",
          at: now,
          source: "system",
          entityType: "loop",
          entityId: id,
          payload: { id, reason: "expires_at" },
        });
        count++;
      }
      return count;
    });
  }

  expireEventLoops(sessionStartedAt: number): number {
    return this.withLock(() => {
      let count = 0;
      for (const [id, entry] of [...this.loops.entries()]) {
        if (entry.status !== "active") continue;
        if (entry.trigger.type !== "event" && entry.trigger.type !== "hybrid") continue;
        if (entry.createdAt >= sessionStartedAt) continue;
        this.applyReducerEvent({
          type: "LOOP_EXPIRED",
          at: sessionStartedAt,
          source: "session",
          entityType: "loop",
          entityId: id,
          payload: { id, reason: "resume_event_stale" },
        });
        count++;
      }
      return count;
    });
  }

  clearAll(): number {
    return this.withLock(() => {
      const ids = [...this.loops.keys()];
      for (const id of ids) {
        this.applyReducerEvent({
          type: "LOOP_DELETED",
          at: Date.now(),
          source: "system",
          entityType: "loop",
          entityId: id,
          payload: { id },
        });
      }
      return ids.length;
    });
  }

  deleteFileIfEmpty(): boolean {
    if (!this.filePath || this.loops.size > 0) return false;
    try { unlinkSync(this.filePath); } catch { /* ignore */ }
    return true;
  }
}
