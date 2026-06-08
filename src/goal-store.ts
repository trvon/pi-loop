import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { type GoalReducerEvent, reduceGoalState } from "./goal-reducer.js";
import type {
  GoalCriteria,
  GoalEntry,
  GoalProgressSnapshot,
  GoalReducerState,
  GoalScope,
  GoalStoreData,
} from "./goal-types.js";

const GOALS_DIR = join(homedir(), ".pi", "goals");
const LOCK_RETRY_MS = 50;
const LOCK_MAX_RETRIES = 100;
const MAX_GOALS = 200;

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

export class GoalStore {
  private filePath: string | undefined;
  private lockPath: string | undefined;

  private nextId = 1;
  private goals = new Map<string, GoalEntry>();

  constructor(listIdOrPath?: string) {
    if (!listIdOrPath) return;
    const isAbsPath = isAbsolute(listIdOrPath);
    const filePath = isAbsPath ? listIdOrPath : join(GOALS_DIR, `${listIdOrPath}.json`);
    mkdirSync(dirname(filePath), { recursive: true });
    this.filePath = filePath;
    this.lockPath = filePath + ".lock";
    this.load();
  }

  private load(): void {
    if (!this.filePath) return;
    if (!existsSync(this.filePath)) return;
    try {
      const data: GoalStoreData = JSON.parse(readFileSync(this.filePath, "utf-8"));
      this.nextId = data.nextId;
      this.goals.clear();
      for (const goal of data.goals) {
        this.goals.set(goal.id, goal);
      }
    } catch { /* corrupt file — start fresh */ }
  }

  private save(): void {
    if (!this.filePath) return;
    const data: GoalStoreData = {
      nextId: this.nextId,
      goals: Array.from(this.goals.values()),
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

  private toReducerState(): GoalReducerState {
    return {
      nextId: this.nextId,
      goalsById: Object.fromEntries(this.goals.entries()),
    };
  }

  private applyReducerEvent(event: GoalReducerEvent): void {
    const result = reduceGoalState(this.toReducerState(), event);
    this.nextId = result.state.nextId;
    this.goals = new Map(Object.entries(result.state.goalsById));
  }

  create(
    title: string,
    description: string,
    scope: GoalScope,
    criteria: GoalCriteria,
    metadata?: Record<string, unknown>,
  ): GoalEntry {
    return this.withLock(() => {
      if (this.goals.size >= MAX_GOALS) {
        throw new Error(`Maximum of ${MAX_GOALS} goals reached. Archive some before creating new ones.`);
      }
      this.applyReducerEvent({
        type: "GOAL_CREATED",
        at: Date.now(),
        source: "tool",
        entityType: "goal",
        payload: {
          title,
          description,
          scope,
          criteria,
          metadata,
        },
      });
      return this.goals.get(String(this.nextId - 1))!;
    });
  }

  get(id: string): GoalEntry | undefined {
    if (this.filePath) this.load();
    return this.goals.get(id);
  }

  list(): GoalEntry[] {
    if (this.filePath) this.load();
    return Array.from(this.goals.values()).sort((a, b) => Number(a.id) - Number(b.id));
  }

  activate(id: string): GoalEntry | undefined {
    return this.withLock(() => {
      if (!this.goals.has(id)) return undefined;
      this.applyReducerEvent({
        type: "GOAL_ACTIVATED",
        at: Date.now(),
        source: "tool",
        entityType: "goal",
        entityId: id,
        payload: { id },
      });
      return this.goals.get(id);
    });
  }

  recordProgress(id: string, progress: GoalProgressSnapshot): GoalEntry | undefined {
    return this.withLock(() => {
      if (!this.goals.has(id)) return undefined;
      this.applyReducerEvent({
        type: "GOAL_PROGRESS_RECORDED",
        at: Date.now(),
        source: "coordinator",
        entityType: "goal",
        entityId: id,
        payload: { id, progress },
      });
      return this.goals.get(id);
    });
  }

  markVerificationStarted(id: string): GoalEntry | undefined {
    return this.withLock(() => {
      if (!this.goals.has(id)) return undefined;
      this.applyReducerEvent({
        type: "GOAL_VERIFICATION_STARTED",
        at: Date.now(),
        source: "coordinator",
        entityType: "goal",
        entityId: id,
        payload: { id },
      });
      return this.goals.get(id);
    });
  }

  markVerified(id: string, reason: string, progress?: GoalProgressSnapshot): GoalEntry | undefined {
    return this.withLock(() => {
      if (!this.goals.has(id)) return undefined;
      this.applyReducerEvent({
        type: "GOAL_VERIFICATION_PASSED",
        at: Date.now(),
        source: "coordinator",
        entityType: "goal",
        entityId: id,
        payload: { id, reason, progress },
      });
      return this.goals.get(id);
    });
  }

  markFailed(id: string, reason: string, progress?: GoalProgressSnapshot): GoalEntry | undefined {
    return this.withLock(() => {
      if (!this.goals.has(id)) return undefined;
      this.applyReducerEvent({
        type: "GOAL_FAILED",
        at: Date.now(),
        source: "coordinator",
        entityType: "goal",
        entityId: id,
        payload: { id, reason, progress },
      });
      return this.goals.get(id);
    });
  }

  markBlocked(id: string, reason: string, progress?: GoalProgressSnapshot): GoalEntry | undefined {
    return this.withLock(() => {
      if (!this.goals.has(id)) return undefined;
      this.applyReducerEvent({
        type: "GOAL_BLOCKED",
        at: Date.now(),
        source: "coordinator",
        entityType: "goal",
        entityId: id,
        payload: { id, reason, progress },
      });
      return this.goals.get(id);
    });
  }

  unblock(id: string): GoalEntry | undefined {
    return this.withLock(() => {
      if (!this.goals.has(id)) return undefined;
      this.applyReducerEvent({
        type: "GOAL_UNBLOCKED",
        at: Date.now(),
        source: "coordinator",
        entityType: "goal",
        entityId: id,
        payload: { id },
      });
      return this.goals.get(id);
    });
  }

  updateDetails(
    id: string,
    fields: {
      title?: string;
      description?: string;
      scope?: GoalScope;
      criteria?: GoalCriteria;
      metadata?: Record<string, unknown>;
    },
  ): GoalEntry | undefined {
    return this.withLock(() => {
      if (!this.goals.has(id)) return undefined;
      if (
        fields.title === undefined
        && fields.description === undefined
        && fields.scope === undefined
        && fields.criteria === undefined
        && fields.metadata === undefined
      ) {
        return this.goals.get(id);
      }
      this.applyReducerEvent({
        type: "GOAL_UPDATED",
        at: Date.now(),
        source: "tool",
        entityType: "goal",
        entityId: id,
        payload: {
          id,
          title: fields.title,
          description: fields.description,
          scope: fields.scope,
          criteria: fields.criteria,
          metadata: fields.metadata,
        },
      });
      return this.goals.get(id);
    });
  }

  archive(id: string, reason?: string): GoalEntry | undefined {
    return this.withLock(() => {
      if (!this.goals.has(id)) return undefined;
      this.applyReducerEvent({
        type: "GOAL_ARCHIVED",
        at: Date.now(),
        source: "tool",
        entityType: "goal",
        entityId: id,
        payload: { id, reason },
      });
      return this.goals.get(id);
    });
  }
}
