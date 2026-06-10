import type { GoalProgressSnapshot, GoalVerificationState } from "../../src/goal-types.js";

/** A zeroed goal-progress snapshot. Spread into goal fixtures; override per-test. */
export function emptyGoalProgress(overrides: Partial<GoalProgressSnapshot> = {}): GoalProgressSnapshot {
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
    ...overrides,
  };
}

/** A zeroed goal-verification state. Spread into goal fixtures; override per-test. */
export function emptyGoalVerification(overrides: Partial<GoalVerificationState> = {}): GoalVerificationState {
  return {
    attempts: 0,
    passes: 0,
    failures: 0,
    ...overrides,
  };
}
