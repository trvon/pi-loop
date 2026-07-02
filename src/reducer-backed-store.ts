import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { AnyReducerEffect } from "./coordinator.js";

const LOCK_RETRY_MS = 50;
const LOCK_MAX_RETRIES = 100;

function acquireLock(lockPath: string): void {
  mkdirSync(dirname(lockPath), { recursive: true });
  for (let i = 0; i < LOCK_MAX_RETRIES; i++) {
    try {
      writeFileSync(lockPath, `${process.pid}`, { flag: "wx" });
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") {
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

export interface ReducerResult<TState> {
  state: TState;
  effects: AnyReducerEffect[];
}

/**
 * Per-store glue the base needs to translate between its internal
 * `{ nextId, entries }` representation, the pure reducer's state shape, and the
 * on-disk JSON shape. Each is a small, allocation-only function.
 */
export interface ReducerBackedStoreConfig<TEntry, TState, TEvent, TData> {
  /** Directory for `<listId>.json` when constructed with a bare list id. */
  baseDir: string;
  reduce: (state: TState, event: TEvent) => ReducerResult<TState>;
  toReducerState: (nextId: number, entries: Map<string, TEntry>) => TState;
  fromReducerState: (state: TState) => { nextId: number; entries: Map<string, TEntry> };
  serialize: (nextId: number, entries: Map<string, TEntry>) => TData;
  deserialize: (data: TData) => { nextId: number; entries: Map<string, TEntry> };
}

/**
 * Shared persistence + reducer-dispatch machinery for the file-backed entity
 * stores (loops, tasks). Owns file locking, signature-gated load, atomic
 * save, and reducer application; subclasses add only their entity-specific
 * command methods.
 *
 * Durability boundary: every mutation runs inside {@link withLock}, which saves
 * the whole file unconditionally after the callback. Reducer effects are
 * therefore *not* the persistence mechanism — they are surfaced to
 * {@link onEffects} (default: no-op) so cross-entity effects (e.g.
 * `DISPATCH_EVENT`, `REQUEST_GOAL_VERIFICATION`) can be forwarded by the runtime
 * without being silently dropped at the reducer call site.
 */
export abstract class ReducerBackedStore<TEntry extends { id: string }, TState, TEvent, TData> {
  protected filePath: string | undefined;
  protected lockPath: string | undefined;
  private lastLoadedSignature: string | undefined;

  protected nextId = 1;
  protected entries = new Map<string, TEntry>();

  private readonly config: ReducerBackedStoreConfig<TEntry, TState, TEvent, TData>;

  constructor(config: ReducerBackedStoreConfig<TEntry, TState, TEvent, TData>, listIdOrPath?: string) {
    this.config = config;
    if (!listIdOrPath) return;
    const filePath = isAbsolute(listIdOrPath) ? listIdOrPath : join(config.baseDir, `${listIdOrPath}.json`);
    mkdirSync(dirname(filePath), { recursive: true });
    this.filePath = filePath;
    this.lockPath = `${filePath}.lock`;
    this.load();
  }

  private getFileSignature(): string | undefined {
    if (!this.filePath || !existsSync(this.filePath)) return undefined;
    const stat = statSync(this.filePath);
    return `${stat.mtimeMs}:${stat.size}`;
  }

  private load(force = false): void {
    if (!this.filePath) return;
    const signature = this.getFileSignature();
    if (!signature) return;
    if (!force && signature === this.lastLoadedSignature) return;
    try {
      const data: TData = JSON.parse(readFileSync(this.filePath, "utf-8"));
      const { nextId, entries } = this.config.deserialize(data);
      this.nextId = nextId;
      this.entries = entries;
      this.lastLoadedSignature = signature;
    } catch { /* corrupt file — start fresh */ }
  }

  private save(): void {
    if (!this.filePath) return;
    const data = this.config.serialize(this.nextId, this.entries);
    const tmpPath = `${this.filePath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(data, null, 2));
    renameSync(tmpPath, this.filePath);
    this.lastLoadedSignature = this.getFileSignature();
  }

  protected withLock<T>(fn: () => T): T {
    if (!this.lockPath) return fn();
    acquireLock(this.lockPath);
    try {
      this.load(true);
      const result = fn();
      this.save();
      return result;
    } finally {
      releaseLock(this.lockPath);
    }
  }

  protected applyReducerEvent(event: TEvent): void {
    const result = this.config.reduce(this.config.toReducerState(this.nextId, this.entries), event);
    const { nextId, entries } = this.config.fromReducerState(result.state);
    this.nextId = nextId;
    this.entries = entries;
    if (result.effects.length > 0) this.onEffects(result.effects);
  }

  /**
   * Hook for reducer effects. Default no-op: durability is owned by
   * {@link withLock}. Override to forward non-persistence effects.
   */
  protected onEffects(_effects: AnyReducerEffect[]): void { /* no-op by default */ }

  /** Reload (signature-gated) and return the entry, or undefined. */
  get(id: string): TEntry | undefined {
    if (this.filePath) this.load();
    return this.entries.get(id);
  }

  /** Reload (signature-gated) and return all entries sorted by numeric id. */
  list(): TEntry[] {
    if (this.filePath) this.load();
    return Array.from(this.entries.values()).sort((a, b) => Number(a.id) - Number(b.id));
  }

  /** Remove the backing file when the store is empty. No-op for memory stores. */
  deleteFileIfEmpty(): boolean {
    if (!this.filePath || this.entries.size > 0) return false;
    try { unlinkSync(this.filePath); } catch { /* ignore */ }
    return true;
  }
}
