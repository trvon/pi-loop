import type {
  GoalCriteria,
  GoalEntry,
  GoalProgressSnapshot,
  GoalReducerState,
  GoalScope,
  GoalVerificationState,
} from "./goal-types.js";

export type GoalReducerEvent =
  | {
    type: "GOAL_CREATED";
    at: number;
    source: "tool" | "command" | "scheduler" | "eventbus" | "monitor" | "session" | "coordinator" | "system";
    entityType?: "goal";
    entityId?: string;
    payload: {
      title: string;
      description: string;
      scope: GoalScope;
      criteria: GoalCriteria;
      metadata?: Record<string, unknown>;
    };
  }
  | {
    type: "GOAL_ACTIVATED" | "GOAL_VERIFICATION_STARTED" | "GOAL_UNBLOCKED";
    at: number;
    source: "tool" | "command" | "scheduler" | "eventbus" | "monitor" | "session" | "coordinator" | "system";
    entityType?: "goal";
    entityId?: string;
    payload: { id: string };
  }
  | {
    type: "GOAL_PROGRESS_RECORDED";
    at: number;
    source: "tool" | "command" | "scheduler" | "eventbus" | "monitor" | "session" | "coordinator" | "system";
    entityType?: "goal";
    entityId?: string;
    payload: { id: string; progress: GoalProgressSnapshot };
  }
  | {
    type: "GOAL_VERIFICATION_PASSED" | "GOAL_VERIFICATION_FAILED" | "GOAL_BLOCKED" | "GOAL_FAILED";
    at: number;
    source: "tool" | "command" | "scheduler" | "eventbus" | "monitor" | "session" | "coordinator" | "system";
    entityType?: "goal";
    entityId?: string;
    payload: { id: string; reason: string; progress?: GoalProgressSnapshot };
  }
  | {
    type: "GOAL_SATISFIED" | "GOAL_ARCHIVED";
    at: number;
    source: "tool" | "command" | "scheduler" | "eventbus" | "monitor" | "session" | "coordinator" | "system";
    entityType?: "goal";
    entityId?: string;
    payload: { id: string; reason?: string };
  }
  | {
    type: "GOAL_UPDATED";
    at: number;
    source: "tool" | "command" | "scheduler" | "eventbus" | "monitor" | "session" | "coordinator" | "system";
    entityType?: "goal";
    entityId?: string;
    payload: {
      id: string;
      title?: string;
      description?: string;
      scope?: GoalScope;
      criteria?: GoalCriteria;
      metadata?: Record<string, unknown>;
    };
  };

export type GoalReducerEffect =
  | {
    type: "PERSIST_GOAL";
    entityType: "goal";
    entityId: string;
    payload: { goal: GoalEntry };
  }
  | {
    type: "REQUEST_GOAL_VERIFICATION";
    entityType: "goal";
    entityId: string;
    payload: { id: string };
  };

export interface GoalReduceResult {
  state: GoalReducerState;
  effects: GoalReducerEffect[];
}

function cloneState(state: GoalReducerState): GoalReducerState {
  return {
    nextId: state.nextId,
    goalsById: { ...state.goalsById },
  };
}

function emptyProgress(): GoalProgressSnapshot {
  return {
    totalTasks: 0,
    pendingTasks: 0,
    inProgressTasks: 0,
    completedTasks: 0,
    activeLoops: 0,
    pausedLoops: 0,
    runningMonitors: 0,
    completedMonitors: 0,
    erroredMonitors: 0,
    stoppedMonitors: 0,
  };
}

function emptyVerification(): GoalVerificationState {
  return {
    attempts: 0,
    passes: 0,
    failures: 0,
  };
}

function persist(goal: GoalEntry): GoalReducerEffect {
  return {
    type: "PERSIST_GOAL",
    entityType: "goal",
    entityId: goal.id,
    payload: { goal },
  };
}

function isTerminal(goal: GoalEntry): boolean {
  return goal.status === "satisfied" || goal.status === "failed" || goal.status === "archived";
}

export function reduceGoalState(state: GoalReducerState, event: GoalReducerEvent): GoalReduceResult {
  if (event.type === "GOAL_CREATED") {
    const next = cloneState(state);
    const id = String(next.nextId++);
    const goal: GoalEntry = {
      id,
      title: event.payload.title,
      description: event.payload.description,
      status: "pending",
      verificationStatus: "unknown",
      createdAt: event.at,
      updatedAt: event.at,
      scope: event.payload.scope,
      criteria: event.payload.criteria,
      progress: emptyProgress(),
      verification: emptyVerification(),
      metadata: event.payload.metadata,
    };
    next.goalsById[id] = goal;
    return {
      state: next,
      effects: [persist(goal)],
    };
  }

  const id = event.payload.id;
  const current = state.goalsById[id];
  if (!current) return { state, effects: [] };
  if (isTerminal(current) && event.type !== "GOAL_ARCHIVED") return { state, effects: [] };

  const next = cloneState(state);
  const goal: GoalEntry = {
    ...current,
    progress: { ...current.progress },
    verification: { ...current.verification },
  };

  let extraEffects: GoalReducerEffect[] = [];

  if (event.type === "GOAL_ACTIVATED") {
    goal.status = "active";
    goal.activatedAt ??= event.at;
    goal.updatedAt = event.at;
    extraEffects = [{
      type: "REQUEST_GOAL_VERIFICATION",
      entityType: "goal",
      entityId: id,
      payload: { id },
    }];
  }

  if (event.type === "GOAL_PROGRESS_RECORDED") {
    goal.progress = event.payload.progress;
    goal.updatedAt = event.at;
  }

  if (event.type === "GOAL_VERIFICATION_STARTED") {
    goal.verificationStatus = "checking";
    goal.verification.attempts += 1;
    goal.verification.lastCheckedAt = event.at;
    goal.updatedAt = event.at;
  }

  if (event.type === "GOAL_VERIFICATION_PASSED") {
    if (event.payload.progress) goal.progress = event.payload.progress;
    goal.status = "satisfied";
    goal.verificationStatus = "verified";
    goal.verification.passes += 1;
    goal.verification.lastPassedAt = event.at;
    goal.verification.lastCheckedAt = event.at;
    goal.verification.lastReason = event.payload.reason;
    goal.resolvedAt = event.at;
    goal.updatedAt = event.at;
  }

  if (event.type === "GOAL_VERIFICATION_FAILED") {
    if (event.payload.progress) goal.progress = event.payload.progress;
    goal.verificationStatus = "unverified";
    goal.verification.failures += 1;
    goal.verification.lastFailedAt = event.at;
    goal.verification.lastCheckedAt = event.at;
    goal.verification.lastReason = event.payload.reason;
    if (goal.status === "pending") goal.status = "active";
    goal.updatedAt = event.at;
  }

  if (event.type === "GOAL_BLOCKED") {
    if (event.payload.progress) goal.progress = event.payload.progress;
    goal.status = "blocked";
    goal.verificationStatus = "inconclusive";
    goal.verification.failures += 1;
    goal.verification.lastFailedAt = event.at;
    goal.verification.lastCheckedAt = event.at;
    goal.verification.lastReason = event.payload.reason;
    goal.updatedAt = event.at;
  }

  if (event.type === "GOAL_UNBLOCKED") {
    goal.status = "active";
    goal.updatedAt = event.at;
  }

  if (event.type === "GOAL_SATISFIED") {
    goal.status = "satisfied";
    goal.verificationStatus = "verified";
    goal.verification.lastReason = event.payload.reason ?? goal.verification.lastReason;
    goal.resolvedAt = event.at;
    goal.updatedAt = event.at;
  }

  if (event.type === "GOAL_FAILED") {
    if (event.payload.progress) goal.progress = event.payload.progress;
    goal.status = "failed";
    goal.verificationStatus = "unverified";
    goal.verification.failures += 1;
    goal.verification.lastFailedAt = event.at;
    goal.verification.lastCheckedAt = event.at;
    goal.verification.lastReason = event.payload.reason;
    goal.resolvedAt = event.at;
    goal.updatedAt = event.at;
  }

  if (event.type === "GOAL_ARCHIVED") {
    goal.status = "archived";
    goal.resolvedAt = event.at;
    goal.updatedAt = event.at;
    if (event.payload.reason !== undefined) {
      goal.verification.lastReason = event.payload.reason;
    }
  }

  if (event.type === "GOAL_UPDATED") {
    if (event.payload.title !== undefined) goal.title = event.payload.title;
    if (event.payload.description !== undefined) goal.description = event.payload.description;
    if (event.payload.scope !== undefined) goal.scope = event.payload.scope;
    if (event.payload.criteria !== undefined) goal.criteria = event.payload.criteria;
    if (event.payload.metadata !== undefined) goal.metadata = event.payload.metadata;
    goal.updatedAt = event.at;
  }

  next.goalsById[id] = goal;
  return {
    state: next,
    effects: [persist(goal), ...extraEffects],
  };
}
