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
  currentState: string;
  transitionSeq: number;
  stateEnteredAt: number;
  attemptsByState: Record<string, number>;
  stateFireCounts: Record<string, number>;
  activeTaskId?: string;
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
