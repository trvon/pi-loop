import type { ReducerEffect, ReducerEvent } from "./coordinator.js";
import type { GoalEntry, GoalProgressSnapshot } from "./goal-types.js";
import type { LoopReducerState } from "./loop-reducer.js";
import type { MonitorReducerState } from "./monitor-reducer.js";
import type { TaskReducerState } from "./task-reducer.js";
import type { TaskEntry } from "./task-types.js";
import type { LoopEntry, MonitorEntry } from "./types.js";

export interface GoalVerifierInput {
  goal: GoalEntry;
  taskState: TaskReducerState;
  loopState: LoopReducerState;
  monitorState: MonitorReducerState;
  at: number;
}

export interface GoalVerifierResult {
  progress: GoalProgressSnapshot;
  verdict: "passed" | "failed" | "blocked";
  reason: string;
  effects: ReducerEffect[];
}

function uniqueById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    result.push(item);
  }
  return result;
}

function selectTasks(goal: GoalEntry, taskState: TaskReducerState): TaskEntry[] {
  const selected: TaskEntry[] = [];
  for (const id of goal.scope.taskIds ?? []) {
    const task = taskState.tasksById[id];
    if (task) selected.push(task);
  }
  for (const prefix of goal.scope.subjectPrefixes ?? []) {
    for (const task of Object.values(taskState.tasksById)) {
      if (task.subject.startsWith(prefix)) selected.push(task);
    }
  }
  return uniqueById(selected);
}

function selectLoops(goal: GoalEntry, loopState: LoopReducerState): LoopEntry[] {
  const selected: LoopEntry[] = [];
  for (const id of goal.scope.loopIds ?? []) {
    const loop = loopState.loopsById[id];
    if (loop) selected.push(loop);
  }
  return uniqueById(selected);
}

function selectMonitors(goal: GoalEntry, monitorState: MonitorReducerState): MonitorEntry[] {
  const selected: MonitorEntry[] = [];
  for (const id of goal.scope.monitorIds ?? []) {
    const monitor = monitorState.monitorsById[id];
    if (monitor) selected.push(monitor);
  }
  return uniqueById(selected);
}

export function projectGoalProgress(
  goal: GoalEntry,
  taskState: TaskReducerState,
  loopState: LoopReducerState,
  monitorState: MonitorReducerState,
): GoalProgressSnapshot {
  const tasks = selectTasks(goal, taskState);
  const loops = selectLoops(goal, loopState);
  const monitors = selectMonitors(goal, monitorState);

  const timestamps: number[] = [];
  for (const task of tasks) timestamps.push(task.updatedAt);
  for (const loop of loops) timestamps.push(loop.updatedAt);
  for (const monitor of monitors) timestamps.push(monitor.completedAt ?? monitor.startedAt);

  return {
    totalTasks: tasks.length,
    pendingTasks: tasks.filter(task => task.status === "pending").length,
    inProgressTasks: tasks.filter(task => task.status === "in_progress").length,
    completedTasks: tasks.filter(task => task.status === "completed").length,
    activeLoops: loops.filter(loop => loop.status === "active").length,
    pausedLoops: loops.filter(loop => loop.status === "paused").length,
    runningMonitors: monitors.filter(monitor => monitor.status === "running").length,
    completedMonitors: monitors.filter(monitor => monitor.status === "completed").length,
    erroredMonitors: monitors.filter(monitor => monitor.status === "error").length,
    stoppedMonitors: monitors.filter(monitor => monitor.status === "stopped").length,
    lastProgressAt: timestamps.length > 0 ? Math.max(...timestamps) : undefined,
  };
}

function dispatchEffect(event: ReducerEvent): ReducerEffect<"DISPATCH_EVENT", { event: ReducerEvent }> {
  return {
    type: "DISPATCH_EVENT",
    entityType: "goal",
    entityId: event.entityId,
    payload: { event },
  };
}

function buildEffects(goal: GoalEntry, at: number, progress: GoalProgressSnapshot, resultType: string, reason: string) {
  return [
    dispatchEffect({
      type: "GOAL_VERIFICATION_STARTED",
      at,
      source: "coordinator",
      entityType: "goal",
      entityId: goal.id,
      payload: { id: goal.id },
    }),
    dispatchEffect({
      type: "GOAL_PROGRESS_RECORDED",
      at,
      source: "coordinator",
      entityType: "goal",
      entityId: goal.id,
      payload: { id: goal.id, progress },
    }),
    dispatchEffect({
      type: resultType,
      at,
      source: "coordinator",
      entityType: "goal",
      entityId: goal.id,
      payload: { id: goal.id, reason, progress },
    }),
  ];
}

export function verifyGoal(input: GoalVerifierInput): GoalVerifierResult {
  const { goal, taskState, loopState, monitorState, at } = input;
  const progress = projectGoalProgress(goal, taskState, loopState, monitorState);

  if (goal.criteria.failure?.maxVerificationFailures !== undefined
    && goal.verification.failures >= goal.criteria.failure.maxVerificationFailures) {
    return {
      progress,
      verdict: "failed",
      reason: "maximum verification failures reached",
      effects: buildEffects(goal, at, progress, "GOAL_FAILED", "maximum verification failures reached"),
    };
  }

  for (const monitorId of goal.criteria.failure?.anyMonitorIdsErrored ?? []) {
    if (monitorState.monitorsById[monitorId]?.status === "error") {
      return {
        progress,
        verdict: "failed",
        reason: `monitor #${monitorId} errored`,
        effects: buildEffects(goal, at, progress, "GOAL_FAILED", `monitor #${monitorId} errored`),
      };
    }
  }

  for (const taskId of goal.criteria.failure?.failIfTaskIdsDeleted ?? []) {
    if (!taskState.tasksById[taskId]) {
      return {
        progress,
        verdict: "failed",
        reason: `task #${taskId} missing`,
        effects: buildEffects(goal, at, progress, "GOAL_FAILED", `task #${taskId} missing`),
      };
    }
  }

  const requiredTasksDone = (goal.criteria.success.requiredTaskIds ?? [])
    .every(taskId => taskState.tasksById[taskId]?.status === "completed");
  const requiredMonitorsDone = (goal.criteria.success.requiredMonitorIdsCompleted ?? [])
    .every(monitorId => monitorState.monitorsById[monitorId]?.status === "completed");
  const requiredLoopsPresent = (goal.criteria.success.requiredLoopIdsPresent ?? [])
    .every(loopId => Boolean(loopState.loopsById[loopId]));
  const minCompletedTasksMet = progress.completedTasks >= (goal.criteria.success.minCompletedTasks ?? 0);
  const noPendingWork = !goal.criteria.success.requireNoPendingTasksInScope
    || (progress.pendingTasks === 0 && progress.inProgressTasks === 0);
  const latestVerificationPass = !goal.criteria.success.requireLatestVerificationPass
    || goal.verificationStatus === "verified";

  const success = requiredTasksDone
    && requiredMonitorsDone
    && requiredLoopsPresent
    && minCompletedTasksMet
    && noPendingWork
    && latestVerificationPass;

  if (success) {
    return {
      progress,
      verdict: "passed",
      reason: "success criteria satisfied",
      effects: buildEffects(goal, at, progress, "GOAL_VERIFICATION_PASSED", "success criteria satisfied"),
    };
  }

  if (goal.criteria.blocked?.blockedIfRequiredLoopMissing && !requiredLoopsPresent) {
    return {
      progress,
      verdict: "blocked",
      reason: "required loop missing",
      effects: buildEffects(goal, at, progress, "GOAL_BLOCKED", "required loop missing"),
    };
  }

  if (
    goal.criteria.blocked?.blockedIfNoScopedProgressSinceMs !== undefined
    && progress.lastProgressAt !== undefined
    && at - progress.lastProgressAt >= goal.criteria.blocked.blockedIfNoScopedProgressSinceMs
  ) {
    return {
      progress,
      verdict: "blocked",
      reason: "no scoped progress within configured interval",
      effects: buildEffects(goal, at, progress, "GOAL_BLOCKED", "no scoped progress within configured interval"),
    };
  }

  if (
    goal.criteria.blocked?.blockedIfAllTasksCompletedButVerificationFails
    && progress.totalTasks > 0
    && progress.pendingTasks === 0
    && progress.inProgressTasks === 0
  ) {
    return {
      progress,
      verdict: "blocked",
      reason: "all scoped tasks completed but verification has not passed",
      effects: buildEffects(goal, at, progress, "GOAL_BLOCKED", "all scoped tasks completed but verification has not passed"),
    };
  }

  return {
    progress,
    verdict: "failed",
    reason: "success criteria not yet satisfied",
    effects: buildEffects(goal, at, progress, "GOAL_VERIFICATION_FAILED", "success criteria not yet satisfied"),
  };
}
