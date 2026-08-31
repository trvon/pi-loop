export type LoopDeletionReason = "task_backlog_empty";

export interface LoopDeletionTombstone {
  id: string;
  reason: LoopDeletionReason;
  deletedAt: number;
  prompt: string;
  pendingCount?: number;
}

export type LoopDeletionTombstoneInput = Omit<LoopDeletionTombstone, "id" | "deletedAt" | "prompt">;

export type LoopStatus = "active" | "paused";
export type LoopExpiryDisposition = "deleted" | "paused";
export type LoopExpiryReason = "expires_at" | "resume_event_stale";
export type LoopExpirySource = "scheduler" | "session_recovery";

export type LoopPauseKind = "administrative" | "controller_limit" | "semantic_terminal" | "orchestration_settlement";

export interface LoopPauseRecord {
  kind: LoopPauseKind;
  at: number;
  reason?: string;
}

export type LoopFireOrigin = "scheduler" | "event" | "dynamic" | "monitor";

export interface CronTrigger {
  type: "cron";
  schedule: string;
}

export interface EventTrigger {
  type: "event";
  source: string;
  filter?: string;
}

export interface HybridTrigger {
  type: "hybrid";
  cron: string;
  event: { source: string; filter?: string };
  debounceMs: number;
}

export interface DynamicTrigger {
  type: "dynamic";
}

export type Trigger = CronTrigger | EventTrigger | HybridTrigger | DynamicTrigger;

export interface DynamicLoopState {
  goal: string;
  state?: string;
  metrics?: string;
  doneCriteria?: string;
  iteration: number;
  nextWakeAt?: number;
  awaitingUpdate?: boolean;
  lastUpdatedAt?: number;
}

export type OrchestrationStatus = "active" | "needs_attention" | "completed" | "cancelled";
export type OrchestrationWorkStatus = "pending" | "active" | "completed" | "failed" | "uncertain" | "cancelled";
export type OrchestrationDispatchStatus = "spawning" | "queued" | "running" | "completed" | "failed" | "interrupted" | "stopped" | "uncertain";
export type OrchestrationConsumeStatus = "not_applicable" | "pending" | "consumed" | "unavailable";
export type OrchestrationWakeReason = "completed" | "failed" | "uncertain" | "recovery";

export interface OrchestrationActor {
  sessionId: string;
  runtimeId: string;
  generation: number;
}

export interface OrchestrationOwner extends OrchestrationActor {
  leaseExpiresAt: number;
}

export interface OrchestrationUsage {
  toolUses?: number;
  durationMs?: number;
  tokens?: { input: number; output: number; total: number };
}

export interface OrchestrationDispatch {
  dispatchId: string;
  attempt: number;
  ownerRuntimeId: string;
  ownerGeneration: number;
  status: OrchestrationDispatchStatus;
  requestedAt: number;
  agentId?: string;
  boundAt?: number;
  startedAt?: number;
  settledAt?: number;
  result?: string;
  error?: string;
  consumeStatus: OrchestrationConsumeStatus;
  consumeAttempts: number;
  usage?: OrchestrationUsage;
}

export interface OrchestrationWorkItem {
  id: string;
  prompt: string;
  agentType?: string;
  status: OrchestrationWorkStatus;
  attemptCount: number;
  dispatches: OrchestrationDispatch[];
}

export interface OrchestrationPendingWake {
  reason: OrchestrationWakeReason;
  sequence: number;
  createdAt: number;
}

export interface OrchestrationState {
  version: 1;
  revision: number;
  status: OrchestrationStatus;
  goal: string;
  concurrency: number;
  maxAttempts: number;
  model?: string;
  maxTurns?: number;
  owner: OrchestrationOwner;
  work: OrchestrationWorkItem[];
  nextWakeSequence: number;
  pendingWake?: OrchestrationPendingWake;
  createdAt: number;
  updatedAt: number;
}

export interface OrchestrationDefinitionInput {
  goal: string;
  work: Array<{ prompt: string; agentType?: string }>;
  concurrency?: number;
  maxAttempts?: number;
  model?: string;
  maxTurns?: number;
}

export type WorkflowTerminalStatus = "completed" | "paused";

export interface WorkflowTaskDefinition {
  subject: string;
  description: string;
}

export interface WorkflowMonitorWait {
  monitorId: string;
  stateId: string;
  transitionSeq: number;
  attachedAt: number;
}

export interface WorkflowStateLoopDefinition {
  schedule: string;
  maxFires?: number;
  startImmediately?: boolean;
}

export interface WorkflowStateDefinition {
  prompt: string;
  task?: WorkflowTaskDefinition;
  loop?: WorkflowStateLoopDefinition;
  on?: Record<string, string>;
  terminal?: WorkflowTerminalStatus;
  maxAttempts?: number;
}

export interface WorkflowDefinition {
  version: 1;
  initialState: string;
  states: Record<string, WorkflowStateDefinition>;
}

export interface WorkflowRuntimeActor {
  sessionId: string;
  runtimeId: string;
}

export type WorkflowRevisionChange =
  | {
      op: "add_state";
      stateId: string;
      state: WorkflowStateDefinition;
    }
  | {
      op: "revise_state";
      stateId: string;
      prompt?: string;
      task?: WorkflowTaskDefinition;
      loop?: WorkflowStateLoopDefinition;
      maxAttempts?: number;
    }
  | {
      op: "reissue_state";
      stateId: string;
      prompt: string;
      task?: WorkflowTaskDefinition;
      loop?: WorkflowStateLoopDefinition;
      maxAttempts?: number;
    }
  | {
      op: "add_transition";
      from: string;
      outcome: string;
      to: string;
    }
  | {
      op: "redirect_transition";
      from: string;
      outcome: string;
      expectedTo: string;
      to: string;
    };

export interface WorkflowDefinitionRevision {
  revision: number;
  definition: WorkflowDefinition;
  reason: string;
  supersededAt: number;
  supersededBy: WorkflowRuntimeActor;
  changes: WorkflowRevisionChange[];
}

export type WorkflowRevisionFailureCode =
  | "loop_not_found"
  | "not_workflow"
  | "revision_conflict"
  | "run_conflict"
  | "terminal_workflow"
  | "workflow_paused"
  | "monitor_wait_active"
  | "revision_limit_reached"
  | "actor_required"
  | "execution_missing"
  | "execution_unowned"
  | "lease_expired"
  | "lease_owned_elsewhere"
  | "invalid_patch"
  | "current_state_immutable"
  | "state_conflict"
  | "edge_conflict"
  | "dependency_not_preserved"
  | "graph_invalid"
  | "definition_too_large";

export interface WorkflowRevisionFailure {
  code: WorkflowRevisionFailureCode;
  message: string;
  expectedRevision?: number;
  currentRevision?: number;
  expectedState?: string;
  currentState?: string;
  expectedTransitionSeq?: number;
  currentTransitionSeq?: number;
  stateId?: string;
}

export interface WorkflowExecutionLease {
  ownerSessionId: string;
  ownerRuntimeId: string;
  acquiredAt: number;
  heartbeatAt: number;
  expiresAt: number;
  attempt: number;
}

export interface WorkflowExecutionRecord {
  id: string;
  stateId: string;
  transitionSeq: number;
  subject: string;
  description: string;
  status: "active" | "completed" | "cancelled";
  createdAt: number;
  updatedAt: number;
  settledAt?: number;
  evidence?: string;
  lease?: WorkflowExecutionLease;
}

export interface WorkflowAdmissionRecord {
  claimClass: "environmental" | "user_authority";
  provider: string;
  subject: string;
  fact: string;
  expected: string | number | boolean | null;
  observations: string[];
  decidedAt: number;
}

export interface WorkflowTransitionRecord {
  from: string;
  to: string;
  outcome: string;
  evidence?: string;
  admission?: WorkflowAdmissionRecord;
  at: number;
  sequence: number;
}

export interface WorkflowRunState {
  definition: WorkflowDefinition;
  definitionRevision: number;
  revisionHistory: WorkflowDefinitionRevision[];
  currentState: string;
  transitionSeq: number;
  stateEnteredAt: number;
  attemptsByState: Record<string, number>;
  stateFireCounts: Record<string, number>;
  activeExecution?: WorkflowExecutionRecord;
  executionHistory?: WorkflowExecutionRecord[];
  waitingMonitor?: WorkflowMonitorWait;
  lastTransition?: WorkflowTransitionRecord;
}

export interface LoopEntry {
  id: string;
  prompt: string;
  trigger: Trigger;
  status: LoopStatus;
  recurring: boolean;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  autoTask?: boolean;
  taskBacklog?: boolean;
  readOnly?: boolean;
  maxFires?: number;
  fireCount?: number;
  pause?: LoopPauseRecord;
  dynamic?: DynamicLoopState;
  workflow?: WorkflowRunState;
  orchestration?: OrchestrationState;
}

export interface LoopStoreData {
  nextId: number;
  loops: LoopEntry[];
}

export interface MonitorEntry {
  id: string;
  command: string;
  description?: string;
  timeout: number;
  status: "running" | "completed" | "error" | "stopped";
  startedAt: number;
  completedAt?: number;
  exitCode?: number;
  stopReason?: "manual" | "timeout";
  outputLines: number;
  outputBuffer: string[];
  lastActivityAt?: number;
  lastOutputAt?: number;
  outputRatePerMinute?: number;
  progress?: MonitorProgress;
}

export interface MonitorOutcome {
  monitorId: string;
  status: MonitorEntry["status"];
  exitCode?: number;
  stopReason?: MonitorEntry["stopReason"];
  outputLines: number;
}

export interface MonitorProgress {
  current?: number;
  total?: number;
  message?: string;
  source: "jsonl" | "agent";
  updatedAt: number;
}

export interface MonitorProcess {
  entry: MonitorEntry;
  pid: number;
  proc: import("node:child_process").ChildProcess;
  abortController: AbortController;
  deadlineTimer?: ReturnType<typeof setTimeout>;
  waiters: Array<() => void>;
  completionCallbacks: Array<(monitor: MonitorEntry) => void>;
  terminalCallbacks: Array<(monitor: MonitorEntry) => void>;
  terminalReady: boolean;
  lastActivityAt: number;
  lastActivityMonotonic: number;
  lastOutputEventAt: number;
  lastProgressChangeAt: number;
  progressChangeTimer?: ReturnType<typeof setTimeout>;
  pendingOutputLines: number;
  latestOutputLine?: string;
  outputBuckets: Array<{ second: number; count: number }>;
  stdoutDecoder: import("node:string_decoder").StringDecoder;
  stderrDecoder: import("node:string_decoder").StringDecoder;
  stdoutRemainder: string;
  stderrRemainder: string;
}
