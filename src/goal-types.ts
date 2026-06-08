export type GoalStatus =
  | "pending"
  | "active"
  | "satisfied"
  | "blocked"
  | "failed"
  | "archived";

export type GoalVerificationStatus =
  | "unknown"
  | "checking"
  | "verified"
  | "unverified"
  | "inconclusive";

export interface GoalScope {
  taskIds?: string[];
  loopIds?: string[];
  monitorIds?: string[];
  tags?: string[];
  subjectPrefixes?: string[];
  includeFutureMatchingTasks?: boolean;
  includeFutureMatchingLoops?: boolean;
  includeFutureMatchingMonitors?: boolean;
}

export interface GoalSuccessCriteria {
  minCompletedTasks?: number;
  requiredTaskIds?: string[];
  requiredMonitorIdsCompleted?: string[];
  requiredLoopIdsPresent?: string[];
  requireNoPendingTasksInScope?: boolean;
  requireLatestVerificationPass?: boolean;
}

export interface GoalFailureCriteria {
  anyMonitorIdsErrored?: string[];
  maxVerificationFailures?: number;
  failIfTaskIdsDeleted?: string[];
}

export interface GoalBlockedCriteria {
  blockedIfAllTasksCompletedButVerificationFails?: boolean;
  blockedIfNoScopedProgressSinceMs?: number;
  blockedIfRequiredLoopMissing?: boolean;
}

export interface GoalCriteria {
  success: GoalSuccessCriteria;
  failure?: GoalFailureCriteria;
  blocked?: GoalBlockedCriteria;
}

export interface GoalProgressSnapshot {
  totalTasks: number;
  pendingTasks: number;
  inProgressTasks: number;
  completedTasks: number;
  activeLoops: number;
  pausedLoops: number;
  runningMonitors: number;
  completedMonitors: number;
  erroredMonitors: number;
  stoppedMonitors: number;
  lastProgressAt?: number;
}

export interface GoalVerificationState {
  attempts: number;
  passes: number;
  failures: number;
  lastCheckedAt?: number;
  lastPassedAt?: number;
  lastFailedAt?: number;
  lastReason?: string;
  nextCheckAfter?: number;
}

export interface GoalEntry {
  id: string;
  title: string;
  description: string;
  status: GoalStatus;
  verificationStatus: GoalVerificationStatus;
  createdAt: number;
  updatedAt: number;
  activatedAt?: number;
  resolvedAt?: number;
  scope: GoalScope;
  criteria: GoalCriteria;
  progress: GoalProgressSnapshot;
  verification: GoalVerificationState;
  metadata?: Record<string, unknown>;
}

export interface GoalReducerState {
  nextId: number;
  goalsById: Record<string, GoalEntry>;
}

export interface GoalStoreData {
  nextId: number;
  goals: GoalEntry[];
}
