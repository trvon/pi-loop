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

export interface WorkflowTransitionRecord {
  from: string;
  to: string;
  outcome: string;
  evidence?: string;
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
  dynamic?: DynamicLoopState;
  workflow?: WorkflowRunState;
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
