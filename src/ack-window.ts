import type { WindowSeed } from "./types.js";

/**
 * ACK-clocked AIMD window modelled on TCP Reno (Jacobson & Karels 1988;
 * RFC 5681; Chiu & Jain 1989).
 *
 * The window bounds how much work may be in flight before external evidence
 * acknowledges it. It is pure and deterministic: identical signal sequences
 * produce identical windows, so pacing never depends on the model's own
 * judgement of whether it is finished.
 *
 * Loss is classified before it reaches the window. Only congestion evidence
 * shrinks it; a task that fails its own check is the task's problem, not the
 * path's (the TCP-over-wireless lesson).
 */

export interface AckWindow {
  mode: "aimd";
  /** Congestion window; fractional so additive increase accrues across ACKs. */
  cwnd: number;
  /** Slow-start threshold: below it each ACK adds one unit, above it ~1/cwnd. */
  ssthresh: number;
  acks: number;
  /** Congestion and timeout signals, including ones absorbed by recovery. */
  losses: number;
  /** Task failures: counted, never applied to the window. */
  taskLosses: number;
  /**
   * Time of the last reduction. Congestion from work dispatched at or before
   * it belongs to the same window and is not cut again (NewReno, RFC 6582).
   */
  recoverAt?: number;
  /**
   * Lowest observed milliseconds per output token, per tool-use class: the
   * uncongested floor for comparable work. Worker duration includes the
   * worker's own tool time, so a tool-less answer and a tool-heavy one are not
   * comparable and never share a floor.
   */
  delayFloors?: Partial<Record<DelayClass, number>>;
  /** Written by releases that kept one floor for all work; no longer read. */
  minMsPerToken?: number;
  /**
   * Consecutive first-attempt samples above the delay threshold, per tool-use
   * class. The sample that completes a run of DELAY_CONGESTION_STREAK is
   * reported as congestion; later ones in the same run are not reported again
   * until a comparable sample was fast.
   */
  delayRuns?: Partial<Record<DelayClass, number>>;
  /** Written by releases that kept one streak for all work; no longer read. */
  delayStreak?: number;
}

/** Tool-use classes for the delay signal: none, light, moderate, heavy. */
export type DelayClass = "0" | "1" | "2" | "3";
const DELAY_CLASSES: readonly DelayClass[] = ["0", "1", "2", "3"];

/** Undefined when the provider reported no tool-use count: such work has no comparable floor. */
export function delayClass(toolUses: number | undefined): DelayClass | undefined {
  if (toolUses === undefined || !Number.isFinite(toolUses) || toolUses < 0) return undefined;
  if (toolUses === 0) return "0";
  if (toolUses <= 4) return "1";
  return toolUses <= 16 ? "2" : "3";
}

/**
 * - `ack`: externally verified (or, without a verifier, non-empty) first-attempt success.
 * - `retry_ack`: success that needed a retry; ambiguous like a retransmitted
 *   segment under Karn's algorithm, so it is counted but never grows.
 * - `delayed_ack`: success inside a slow run that was already reported; counted, never grows,
 *   and never cuts again, so a mis-set floor costs one reduction rather than a collapse.
 * - `task_loss`: the work itself failed (check failed, empty, generic error).
 * - `congestion`: overload evidence while other work still completes; halve once per window.
 * - `timeout`: the path stopped answering; collapse to one and slow-start.
 */
export type AckSignal = "ack" | "retry_ack" | "delayed_ack" | "task_loss" | "congestion" | "timeout";

/** Per-token latency above this multiple of the floor means a queue is building. */
export const DELAY_CONGESTION_FACTOR = 2;
/**
 * Slow samples needed in a row before delay counts as congestion. Worker
 * duration includes the task's own tool time, so one slow sample is as likely
 * a heavy task as a queue; a run of them is not.
 */
export const DELAY_CONGESTION_STREAK = 2;

const CONGESTION_ERROR = /\b(429|503|rate.?limit|overload(ed)?|too many requests|capacity|server busy|ECONNRESET|ECONNREFUSED|socket hang up)\b/i;
const TIMEOUT_ERROR = /\b(timed? ?out|timeout|ETIMEDOUT|deadline exceeded)\b/i;

/**
 * Initial window: the fixed-pacing default, so an aimd batch is never slower
 * to start than a default fixed one (cf. RFC 6928's larger initial window).
 * Timeouts still collapse to one.
 */
export const INITIAL_WINDOW = 3;

export function createAckWindow(ceiling: number, seed?: WindowSeed): AckWindow {
  return {
    mode: "aimd",
    cwnd: Math.min(seed?.cwnd ?? INITIAL_WINDOW, ceiling),
    ssthresh: Math.min(seed?.ssthresh ?? ceiling, ceiling),
    acks: 0,
    losses: 0,
    taskLosses: 0,
  };
}

export function windowCapacity(window: AckWindow, ceiling: number): number {
  return Math.max(1, Math.min(ceiling, Math.floor(window.cwnd)));
}

export interface SignalContext {
  at: number;
  /** When the settling work was dispatched; ties a loss to the window it was sent in. */
  requestedAt: number;
  /** The provider refused the work before it ran: the slot was lost, not the work. */
  rejected?: boolean;
}

/** Window kept after congestion that lost work in flight (Reno). */
export const CONGESTION_BACKOFF = 0.5;
/**
 * Window kept after an admission rejection. Nothing ran, so the loss is cheap
 * and a gentler cut (CUBIC's beta, RFC 9438) holds more of the probed window.
 */
export const ADMISSION_BACKOFF = 0.7;

export function applyAckSignal(window: AckWindow, signal: AckSignal, ceiling: number, context: SignalContext): AckWindow {
  if (signal === "task_loss") return { ...window, taskLosses: window.taskLosses + 1 };
  if (signal === "retry_ack" || signal === "delayed_ack") return { ...window, acks: window.acks + 1 };
  if (signal === "ack") {
    const growth = window.cwnd < window.ssthresh ? 1 : 1 / window.cwnd;
    return { ...window, cwnd: Math.min(ceiling, window.cwnd + growth), acks: window.acks + 1 };
  }
  const sameWindow = window.recoverAt !== undefined && context.requestedAt <= window.recoverAt;
  if (signal === "congestion" && sameWindow) return { ...window, losses: window.losses + 1 };
  // RFC 5681: repeated timeouts for the same flight reset the window but hold ssthresh.
  if (signal === "timeout" && sameWindow) return { ...window, cwnd: 1, losses: window.losses + 1 };
  const half = Math.max(1, Math.floor(window.cwnd * (signal === "congestion" && context.rejected ? ADMISSION_BACKOFF : CONGESTION_BACKOFF)));
  return {
    ...window,
    cwnd: signal === "timeout" ? 1 : half,
    ssthresh: half,
    losses: window.losses + 1,
    recoverAt: context.at,
  };
}

export interface SettlementEvidence {
  outcome: "completed" | "failed";
  result?: string;
  error?: string;
  attempt: number;
  /** Present when the work item declared a verifier and it ran. */
  verifyPassed?: boolean;
  durationMs?: number;
  outputTokens?: number;
  toolUses?: number;
}

/** Error text that names overload or a dropped connection rather than the task. */
export function isCongestionError(error: string): boolean {
  return CONGESTION_ERROR.test(error);
}

export function msPerToken(evidence: Pick<SettlementEvidence, "durationMs" | "outputTokens">): number | undefined {
  const { durationMs, outputTokens } = evidence;
  if (durationMs === undefined || outputTokens === undefined || !Number.isFinite(durationMs) || durationMs <= 0 || outputTokens < 1) return undefined;
  return durationMs / outputTokens;
}

export function classifySettlement(evidence: SettlementEvidence, window: Pick<AckWindow, "delayFloors" | "delayRuns">): AckSignal {
  if (evidence.outcome === "failed") {
    const error = evidence.error ?? "";
    if (TIMEOUT_ERROR.test(error)) return "timeout";
    if (CONGESTION_ERROR.test(error)) return "congestion";
    return "task_loss";
  }
  if (evidence.verifyPassed === false) return "task_loss";
  if (evidence.verifyPassed === undefined && !evidence.result?.trim()) return "task_loss";
  if (evidence.attempt > 1) return "retry_ack";
  if (!isDelayed(evidence, window)) return "ack";
  const run = delayRun(window, evidence) + 1;
  if (run < DELAY_CONGESTION_STREAK) return "ack";
  return run === DELAY_CONGESTION_STREAK ? "congestion" : "delayed_ack";
}

type DelaySample = Pick<SettlementEvidence, "durationMs" | "outputTokens" | "toolUses">;

function isDelayed(evidence: DelaySample, window: Pick<AckWindow, "delayFloors">): boolean {
  const sample = msPerToken(evidence);
  const sampleClass = delayClass(evidence.toolUses);
  const floor = sampleClass === undefined ? undefined : window.delayFloors?.[sampleClass];
  return sample !== undefined && floor !== undefined && sample > floor * DELAY_CONGESTION_FACTOR;
}

function delayRun(window: Pick<AckWindow, "delayRuns">, evidence: DelaySample): number {
  const sampleClass = delayClass(evidence.toolUses);
  return sampleClass === undefined ? 0 : window.delayRuns?.[sampleClass] ?? 0;
}

/**
 * Fold a delay sample into its class's floor and slow run. Retried work is
 * excluded (Karn), as is work with no tool-use count. Only a fast sample of the
 * same class ends that class's run; other classes neither extend nor clear it.
 */
export function observeDelay(window: AckWindow, evidence: DelaySample & Pick<SettlementEvidence, "attempt">): AckWindow {
  const sample = msPerToken(evidence);
  const sampleClass = delayClass(evidence.toolUses);
  if (sample === undefined || sampleClass === undefined || evidence.attempt > 1) return window;
  // Past the reporting point the exact length carries no information, so it is not counted further.
  const run = isDelayed(evidence, window) ? Math.min(delayRun(window, evidence) + 1, DELAY_CONGESTION_STREAK + 1) : 0;
  const floor = window.delayFloors?.[sampleClass];
  return {
    ...window,
    delayFloors: { ...window.delayFloors, [sampleClass]: floor === undefined ? sample : Math.min(floor, sample) },
    delayRuns: { ...window.delayRuns, [sampleClass]: run },
  };
}

export function validateAckWindow(value: unknown, ceiling: number): value is AckWindow {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const window = value as Record<string, unknown>;
  const count = (field: unknown) => Number.isInteger(field) && Number(field) >= 0;
  const optionalFinite = (field: unknown, min: number) => field === undefined || (typeof field === "number" && Number.isFinite(field) && field >= min);
  return window.mode === "aimd"
    && typeof window.cwnd === "number" && Number.isFinite(window.cwnd) && window.cwnd >= 1 && window.cwnd <= ceiling
    && Number.isInteger(window.ssthresh) && Number(window.ssthresh) >= 1 && Number(window.ssthresh) <= ceiling
    && count(window.acks) && count(window.losses) && count(window.taskLosses)
    && optionalFinite(window.recoverAt, 0)
    && optionalFinite(window.minMsPerToken, Number.MIN_VALUE)
    && validDelayFloors(window.delayFloors)
    && validDelayRuns(window.delayRuns)
    && (window.delayStreak === undefined || count(window.delayStreak));
}

function validDelayFloors(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(([key, floor]) => (DELAY_CLASSES as readonly string[]).includes(key)
    && typeof floor === "number" && Number.isFinite(floor) && floor > 0);
}

function validDelayRuns(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(([key, run]) => (DELAY_CLASSES as readonly string[]).includes(key)
    && Number.isInteger(run) && Number(run) >= 0 && Number(run) <= DELAY_CONGESTION_STREAK + 1);
}
