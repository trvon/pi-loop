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

export type Trigger = CronTrigger | EventTrigger | HybridTrigger;

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
  outputLines: number;
  outputBuffer: string[];
}

export interface MonitorProcess {
  entry: MonitorEntry;
  pid: number;
  proc: import("node:child_process").ChildProcess;
  abortController: AbortController;
  waiters: Array<() => void>;
}
