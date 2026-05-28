import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { LoopEntry, LoopStatus, LoopStoreData, Trigger } from "./types.js";

const LOOPS_DIR = join(homedir(), ".pi", "loops");
const LOCK_RETRY_MS = 50;
const LOCK_MAX_RETRIES = 100;
const MAX_LOOPS = 25;
const MAX_EXPIRY_DAYS = 7;

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

  create(trigger: Trigger, prompt: string, opts: { recurring: boolean; autoTask?: boolean; selfPaced?: boolean; readOnly?: boolean; maxFires?: number }): LoopEntry {
    return this.withLock(() => {
      if (this.loops.size >= MAX_LOOPS) {
        throw new Error(`Maximum of ${MAX_LOOPS} loops reached. Delete some before creating new ones.`);
      }
      const now = Date.now();
      const entry: LoopEntry = {
        id: String(this.nextId++),
        prompt,
        trigger,
        status: "active",
        recurring: opts.recurring,
        autoTask: opts.autoTask,
        selfPaced: opts.selfPaced,
        readOnly: opts.readOnly,
        maxFires: opts.maxFires,
        fireCount: 0,
        createdAt: now,
        updatedAt: now,
        expiresAt: now + MAX_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
      };
      this.loops.set(entry.id, entry);
      return entry;
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
      if (fields.status !== undefined) {
        entry.status = fields.status;
        changedFields.push("status");
      }
      if (fields.trigger !== undefined) {
        entry.trigger = fields.trigger;
        changedFields.push("trigger");
      }
      if (fields.prompt !== undefined) {
        entry.prompt = fields.prompt;
        changedFields.push("prompt");
      }
      if (fields.fireCount !== undefined) {
        entry.fireCount = fields.fireCount;
        changedFields.push("fireCount");
      }
      entry.updatedAt = Date.now();
      return { entry, changedFields };
    });
  }

  delete(id: string): boolean {
    return this.withLock(() => {
      if (!this.loops.has(id)) return false;
      this.loops.delete(id);
      return true;
    });
  }

  clearExpired(): number {
    return this.withLock(() => {
      const now = Date.now();
      let count = 0;
      for (const [id, entry] of this.loops) {
        if (now >= entry.expiresAt) {
          this.loops.delete(id);
          count++;
        }
      }
      return count;
    });
  }

  expireEventLoops(sessionStartedAt: number): number {
    return this.withLock(() => {
      let count = 0;
      for (const [_id, entry] of this.loops) {
        if (entry.status !== "active") continue;
        if (entry.trigger.type === "event" || entry.trigger.type === "hybrid") {
          if (entry.createdAt < sessionStartedAt) {
            entry.status = "expired";
            count++;
          }
        }
      }
      return count;
    });
  }

  clearAll(): number {
    return this.withLock(() => {
      const count = this.loops.size;
      this.loops.clear();
      return count;
    });
  }

  deleteFileIfEmpty(): boolean {
    if (!this.filePath || this.loops.size > 0) return false;
    try { unlinkSync(this.filePath); } catch { /* ignore */ }
    return true;
  }
}
