import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { AnyReducerEffect } from "./coordinator.js";

const LOCK_RETRY_MS = 50;
const LOCK_MAX_RETRIES = 100;

export class StoreCorruptionError extends Error {
  constructor(filePath: string, cause?: unknown) {
    super(`Corrupt store ${filePath}; no valid previous snapshot`, { cause });
    this.name = "StoreCorruptionError";
  }
}

interface LockOwner {
  contents: string;
}

function acquireLock(lockPath: string): LockOwner {
  mkdirSync(dirname(lockPath), { recursive: true });
  const token = randomUUID();
  const owner: LockOwner = { contents: `${process.pid}:${token}` };
  const candidatePath = `${lockPath}.${token}.candidate`;
  writeFileSync(candidatePath, owner.contents, { flag: "wx" });
  try {
    for (let i = 0; i < LOCK_MAX_RETRIES; i++) {
      try {
        // A hard link publishes the complete owner record atomically. Creating the
        // final lock and filling it in separate syscalls leaves a stealable empty inode.
        linkSync(candidatePath, lockPath);
        return owner;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") {
          try {
            const contents = readFileSync(lockPath, "utf-8");
            const pidPrefix = /^(\d+)/.exec(contents);
            if (contents.length > 0 && (!pidPrefix || !isProcessRunning(Number(pidPrefix[1])))) {
              try { unlinkSync(lockPath); } catch { /* another acquirer won stale cleanup */ }
              continue;
            }
          } catch { /* unreadable or concurrently replaced locks stay fenced */ }
          const start = Date.now();
          while (Date.now() - start < LOCK_RETRY_MS) { /* busy wait */ }
          continue;
        }
        throw e;
      }
    }
    throw new Error(`Failed to acquire lock: ${lockPath}`);
  } finally {
    try { unlinkSync(candidatePath); } catch { /* linked lock retains the inode */ }
  }
}

function releaseLock(lockPath: string, owner: LockOwner): void {
  try {
    if (readFileSync(lockPath, "utf-8") === owner.contents) unlinkSync(lockPath);
  } catch { /* never remove a lock whose ownership cannot be confirmed */ }
}

function isProcessRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export interface ReducerResult<TState, TEffect extends AnyReducerEffect = AnyReducerEffect> {
  state: TState;
  effects: TEffect[];
}

/**
 * Per-store glue the base needs to translate between its internal
 * `{ nextId, entries }` representation, the pure reducer's state shape, and the
 * on-disk JSON shape. Each is a small, allocation-only function.
 */
export interface ReducerBackedStoreConfig<TEntry, TState, TEvent, TData, TEffect extends AnyReducerEffect = AnyReducerEffect> {
  /** Directory for `<listId>.json` when constructed with a bare list id. */
  baseDir: string;
  reduce: (state: TState, event: TEvent) => ReducerResult<TState, TEffect>;
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
 * the whole file after successful mutations. Rejected commands can explicitly
 * skip persistence so normalization during load does not rewrite the snapshot.
 * Reducer effects are
 * therefore *not* the persistence mechanism — they are surfaced to
 * {@link onEffects} (default: no-op) so cross-entity effects (e.g.
 * `DISPATCH_EVENT`, `REQUEST_GOAL_VERIFICATION`) can be forwarded by the runtime
 * without being silently dropped at the reducer call site.
 */
export abstract class ReducerBackedStore<
  TEntry extends { id: string },
  TState,
  TEvent,
  TData,
  TEffect extends AnyReducerEffect = AnyReducerEffect,
> {
  protected filePath: string | undefined;
  protected lockPath: string | undefined;
  private lastLoadedSignature: string | undefined;

  protected nextId = 1;
  protected entries = new Map<string, TEntry>();

  private readonly config: ReducerBackedStoreConfig<TEntry, TState, TEvent, TData, TEffect>;

  constructor(config: ReducerBackedStoreConfig<TEntry, TState, TEvent, TData, TEffect>, listIdOrPath?: string) {
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

  private parseSnapshot(filePath: string): { nextId: number; entries: Map<string, TEntry>; raw: string } {
    const raw = readFileSync(filePath, "utf-8");
    try {
      const data: TData = JSON.parse(raw);
      const { nextId, entries } = this.config.deserialize(data);
      return { nextId, entries, raw };
    } catch (error) {
      throw new StoreCorruptionError(filePath, error);
    }
  }

  private syncDirectory(): void {
    if (!this.filePath) return;
    const fd = openSync(dirname(this.filePath), "r");
    try {
      // Directory fsync is best-effort dirent durability (POSIX only). Windows'
      // FlushFileBuffers needs write access on the handle and throws EPERM on a
      // read-only directory descriptor, and the file fsync in writeSnapshot()
      // already made the bytes durable.
      try {
        fsyncSync(fd);
      } catch (error) {
        if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") return;
        throw error;
      }
    } finally {
      closeSync(fd);
    }
  }

  private writeSnapshot(filePath: string, raw: string): void {
    const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(tmpPath, "wx", 0o600);
      writeFileSync(fd, raw);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(tmpPath, filePath);
      this.syncDirectory();
    } finally {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(tmpPath); } catch { /* already renamed or never created */ }
    }
  }

  private recoverPrevious(cause: unknown): void {
    if (!this.filePath) return;
    const previousPath = `${this.filePath}.prev`;
    let previous: { nextId: number; entries: Map<string, TEntry>; raw: string };
    try {
      previous = this.parseSnapshot(previousPath);
    } catch (previousError) {
      throw new StoreCorruptionError(this.filePath, { current: cause, previous: previousError });
    }

    const quarantinePath = `${this.filePath}.corrupt-${Date.now()}-${process.pid}`;
    renameSync(this.filePath, quarantinePath);
    try {
      this.writeSnapshot(this.filePath, previous.raw);
    } catch (recoveryError) {
      try { renameSync(quarantinePath, this.filePath); } catch { /* preserve quarantine when restore fails */ }
      throw new StoreCorruptionError(this.filePath, recoveryError);
    }

    this.nextId = previous.nextId;
    this.entries = previous.entries;
    this.lastLoadedSignature = this.getFileSignature();
  }

  private load(force = false, lockHeld = false): void {
    if (!this.filePath) return;
    const signature = this.getFileSignature();
    if (!signature) return;
    if (!force && signature === this.lastLoadedSignature) return;
    try {
      const { nextId, entries } = this.parseSnapshot(this.filePath);
      this.nextId = nextId;
      this.entries = entries;
      this.lastLoadedSignature = signature;
    } catch (error) {
      if (lockHeld || !this.lockPath) {
        this.recoverPrevious(error);
        return;
      }
      const lockOwner = acquireLock(this.lockPath);
      try {
        this.load(true, true);
      } finally {
        releaseLock(this.lockPath, lockOwner);
      }
    }
  }

  private save(): void {
    if (!this.filePath) return;
    const previousPath = `${this.filePath}.prev`;
    if (existsSync(this.filePath)) {
      const current = this.parseSnapshot(this.filePath);
      this.writeSnapshot(previousPath, current.raw);
    } else {
      try { unlinkSync(previousPath); } catch { /* remove stale backup for a new store */ }
    }
    const data = this.config.serialize(this.nextId, this.entries);
    this.writeSnapshot(this.filePath, JSON.stringify(data, null, 2));
    this.lastLoadedSignature = this.getFileSignature();
  }

  protected withLock<T>(fn: () => T, shouldSave: (result: T) => boolean = () => true): T {
    if (!this.lockPath) return fn();
    const lockOwner = acquireLock(this.lockPath);
    try {
      this.load(true, true);
      const result = fn();
      if (shouldSave(result)) this.save();
      return result;
    } finally {
      releaseLock(this.lockPath, lockOwner);
    }
  }

  protected applyReducerEvent(event: TEvent): ReducerResult<TState, TEffect> {
    const result = this.config.reduce(this.config.toReducerState(this.nextId, this.entries), event);
    const { nextId, entries } = this.config.fromReducerState(result.state);
    this.nextId = nextId;
    this.entries = entries;
    if (result.effects.length > 0) this.onEffects(result.effects);
    return result;
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
    try { unlinkSync(`${this.filePath}.prev`); } catch { /* ignore */ }
    return true;
  }
}
