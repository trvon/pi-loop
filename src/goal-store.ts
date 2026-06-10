import { homedir } from "node:os";
import { join } from "node:path";
import { type GoalReducerEvent, reduceGoalState } from "./goal-reducer.js";
import type {
  GoalCriteria,
  GoalEntry,
  GoalProgressSnapshot,
  GoalReducerState,
  GoalScope,
  GoalStoreData,
} from "./goal-types.js";
import { ReducerBackedStore } from "./reducer-backed-store.js";

const GOALS_DIR = join(homedir(), ".pi", "goals");
const MAX_GOALS = 200;

export class GoalStore extends ReducerBackedStore<GoalEntry, GoalReducerState, GoalReducerEvent, GoalStoreData> {
  constructor(listIdOrPath?: string) {
    super(
      {
        baseDir: GOALS_DIR,
        reduce: (state, event) => reduceGoalState(state, event),
        toReducerState: (nextId, entries) => ({ nextId, goalsById: Object.fromEntries(entries.entries()) }),
        fromReducerState: (state) => ({ nextId: state.nextId, entries: new Map(Object.entries(state.goalsById)) }),
        serialize: (nextId, entries) => ({ nextId, goals: Array.from(entries.values()) }),
        deserialize: (data) => ({ nextId: data.nextId, entries: new Map(data.goals.map((g) => [g.id, g])) }),
      },
      listIdOrPath,
    );
  }

  create(
    title: string,
    description: string,
    scope: GoalScope,
    criteria: GoalCriteria,
    metadata?: Record<string, unknown>,
  ): GoalEntry {
    return this.withLock(() => {
      if (this.entries.size >= MAX_GOALS) {
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
      return this.entries.get(String(this.nextId - 1))!;
    });
  }

  activate(id: string): GoalEntry | undefined {
    return this.withLock(() => {
      if (!this.entries.has(id)) return undefined;
      this.applyReducerEvent({
        type: "GOAL_ACTIVATED",
        at: Date.now(),
        source: "tool",
        entityType: "goal",
        entityId: id,
        payload: { id },
      });
      return this.entries.get(id);
    });
  }

  recordProgress(id: string, progress: GoalProgressSnapshot): GoalEntry | undefined {
    return this.withLock(() => {
      if (!this.entries.has(id)) return undefined;
      this.applyReducerEvent({
        type: "GOAL_PROGRESS_RECORDED",
        at: Date.now(),
        source: "coordinator",
        entityType: "goal",
        entityId: id,
        payload: { id, progress },
      });
      return this.entries.get(id);
    });
  }

  markVerificationStarted(id: string): GoalEntry | undefined {
    return this.withLock(() => {
      if (!this.entries.has(id)) return undefined;
      this.applyReducerEvent({
        type: "GOAL_VERIFICATION_STARTED",
        at: Date.now(),
        source: "coordinator",
        entityType: "goal",
        entityId: id,
        payload: { id },
      });
      return this.entries.get(id);
    });
  }

  markVerified(id: string, reason: string, progress?: GoalProgressSnapshot): GoalEntry | undefined {
    return this.withLock(() => {
      if (!this.entries.has(id)) return undefined;
      this.applyReducerEvent({
        type: "GOAL_VERIFICATION_PASSED",
        at: Date.now(),
        source: "coordinator",
        entityType: "goal",
        entityId: id,
        payload: { id, reason, progress },
      });
      return this.entries.get(id);
    });
  }

  markFailed(id: string, reason: string, progress?: GoalProgressSnapshot): GoalEntry | undefined {
    return this.withLock(() => {
      if (!this.entries.has(id)) return undefined;
      this.applyReducerEvent({
        type: "GOAL_FAILED",
        at: Date.now(),
        source: "coordinator",
        entityType: "goal",
        entityId: id,
        payload: { id, reason, progress },
      });
      return this.entries.get(id);
    });
  }

  markBlocked(id: string, reason: string, progress?: GoalProgressSnapshot): GoalEntry | undefined {
    return this.withLock(() => {
      if (!this.entries.has(id)) return undefined;
      this.applyReducerEvent({
        type: "GOAL_BLOCKED",
        at: Date.now(),
        source: "coordinator",
        entityType: "goal",
        entityId: id,
        payload: { id, reason, progress },
      });
      return this.entries.get(id);
    });
  }

  unblock(id: string): GoalEntry | undefined {
    return this.withLock(() => {
      if (!this.entries.has(id)) return undefined;
      this.applyReducerEvent({
        type: "GOAL_UNBLOCKED",
        at: Date.now(),
        source: "coordinator",
        entityType: "goal",
        entityId: id,
        payload: { id },
      });
      return this.entries.get(id);
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
      if (!this.entries.has(id)) return undefined;
      if (
        fields.title === undefined
        && fields.description === undefined
        && fields.scope === undefined
        && fields.criteria === undefined
        && fields.metadata === undefined
      ) {
        return this.entries.get(id);
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
      return this.entries.get(id);
    });
  }

  archive(id: string, reason?: string): GoalEntry | undefined {
    return this.withLock(() => {
      if (!this.entries.has(id)) return undefined;
      this.applyReducerEvent({
        type: "GOAL_ARCHIVED",
        at: Date.now(),
        source: "tool",
        entityType: "goal",
        entityId: id,
        payload: { id, reason },
      });
      return this.entries.get(id);
    });
  }
}
