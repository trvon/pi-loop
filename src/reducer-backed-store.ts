import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
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
  ownerName: string;
}

function staleOwner(contents: string): boolean {
  const pidPrefix = /^(\d+)/.exec(contents);
  return pidPrefix ? !isProcessRunning(Number(pidPrefix[1])) : contents.length > 0;
}

function removeStaleDirectoryLock(lockPath: string, token: string): boolean {
  try {
    const names = readdirSync(lockPath);
    if (names.length === 0) {
      rmdirSync(lockPath);
      return true;
    }
    if (names.length === 1 && names[0] === "owner") {
      const ownerPath = join(lockPath, "owner");
      const upgradePath = join(lockPath, `.upgrade-${process.pid}-${token}`);
      try {
        // Keep the predecessor directory non-empty while inspecting a hard link
        // to its exact owner inode, so no replacement can be published beneath us.
        linkSync(ownerPath, upgradePath);
        if (!staleOwner(readFileSync(upgradePath, "utf-8"))) return false;
        try { unlinkSync(ownerPath); } catch { return false; }
      } finally {
        try { unlinkSync(upgradePath); } catch { /* no upgrade claim was published */ }
      }
      try { rmdirSync(lockPath); } catch { /* another identity claim still fences the directory */ }
      return !existsSync(lockPath);
    }
    if (names.length === 1) {
      const name = names[0]!;
      const claimant = /^\.(?:cleanup|upgrade)-(\d+)-[0-9a-f-]+$/.exec(name);
      if (claimant) {
        if (isProcessRunning(Number(claimant[1]))) return false;
        unlinkSync(join(lockPath, name));
        try { rmdirSync(lockPath); } catch { /* a replacement remains fenced */ }
        return !existsSync(lockPath);
      }
      if (!name.startsWith("owner-")) return false;
      const ownerPath = join(lockPath, name);
      if (!staleOwner(readFileSync(ownerPath, "utf-8"))) return false;
      // The UUID-bearing owner name is the identity claim. A replacement
      // directory cannot contain this exact pathname.
      unlinkSync(ownerPath);
      try { rmdirSync(lockPath); } catch { /* a replacement non-empty directory stays fenced */ }
      return !existsSync(lockPath);
    }
    const abandonedUpgrade = names.find((name) => {
      const match = /^\.upgrade-(\d+)-[0-9a-f-]+$/.exec(name);
      return match !== null && !isProcessRunning(Number(match[1]));
    });
    if (names.includes("owner") && abandonedUpgrade) {
      unlinkSync(join(lockPath, abandonedUpgrade));
    }
    // Contenders may die together before either observes exclusive ownership.
    // Reclaim only dead UUID claims; live and unknown entries remain fences.
    let removed = false;
    for (const name of names) {
      if (!name.startsWith("owner-")) continue;
      const ownerPath = join(lockPath, name);
      if (!staleOwner(readFileSync(ownerPath, "utf-8"))) continue;
      unlinkSync(ownerPath);
      removed = true;
    }
    if (removed) {
      try { rmdirSync(lockPath); } catch { /* remaining claims still fence the directory */ }
    }
    return removed;
  } catch {
    return false;
  }
}

function removeStaleLegacyLock(lockPath: string, token: string): boolean {
  const claimPath = `${lockPath}.${token}.legacy`;
  try {
    // The hard link binds inspection to one inode. New code publishes directories,
    // so a replacement owner cannot be removed by this legacy-file migration path.
    linkSync(lockPath, claimPath);
    if (!staleOwner(readFileSync(claimPath, "utf-8"))) return false;
    try { unlinkSync(lockPath); } catch { return false; }
    return true;
  } catch {
    return false;
  } finally {
    try { unlinkSync(claimPath); } catch { /* no migration claim was published */ }
  }
}

function removeStaleLock(lockPath: string, token: string): boolean {
  try {
    return statSync(lockPath).isDirectory()
      ? removeStaleDirectoryLock(lockPath, token)
      : removeStaleLegacyLock(lockPath, token);
  } catch {
    return false;
  }
}

function publishOwnerClaim(lockPath: string, candidatePath: string, owner: LockOwner): boolean {
  const ownerPath = join(lockPath, owner.ownerName);
  let exclusive = false;
  try {
    try { mkdirSync(lockPath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    // Scaffolding grants no authority. The hard link exposes initialized bytes
    // without replacing any existing path, including Windows legacy file locks.
    linkSync(join(candidatePath, owner.ownerName), ownerPath);
    const names = readdirSync(lockPath);
    exclusive = names.length === 1 && names[0] === owner.ownerName;
    return exclusive;
  } finally {
    // A live admitted owner always remains visible to subsequent contenders.
    if (!exclusive) {
      try { unlinkSync(ownerPath); } catch { /* this UUID claim was not published */ }
    }
  }
}

function acquireLock(lockPath: string): LockOwner {
  mkdirSync(dirname(lockPath), { recursive: true });
  const token = randomUUID();
  const owner: LockOwner = {
    contents: `${process.pid}:${token}`,
    ownerName: `owner-${process.pid}-${token}`,
  };
  const candidatePath = `${lockPath}.${token}.candidate`;
  mkdirSync(candidatePath);
  writeFileSync(join(candidatePath, owner.ownerName), owner.contents, { flag: "wx" });
  try {
    for (let i = 0; i < LOCK_MAX_RETRIES; i++) {
      try {
        if (publishOwnerClaim(lockPath, candidatePath, owner)) return owner;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // APFS can report EINVAL, rather than ENOENT, when another contender
        // removes empty scaffolding while linkSync resolves its destination.
        const vanishedScaffolding = code === "EINVAL" && (error as NodeJS.ErrnoException).syscall === "link";
        if (!vanishedScaffolding && code !== "EEXIST" && code !== "ENOTDIR" && code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EPERM" && code !== "EACCES") throw error;
      }
      if (removeStaleLock(lockPath, token)) continue;
      const start = Date.now();
      while (Date.now() - start < LOCK_RETRY_MS) { /* busy wait */ }
    }
    throw new Error(`Failed to acquire lock: ${lockPath}`);
  } finally {
    try { rmSync(candidatePath, { recursive: true, force: true }); } catch { /* private candidate cleanup is best effort */ }
  }
}

function releaseLock(lockPath: string, owner: LockOwner): void {
  try {
    const ownerPath = join(lockPath, owner.ownerName);
    if (readFileSync(ownerPath, "utf-8") !== owner.contents) return;
    unlinkSync(ownerPath);
    try { rmdirSync(lockPath); } catch { /* never remove a replacement owner's directory */ }
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
