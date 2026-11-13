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
   * it belongs to the same window and is not cut again (Reno fast recovery).
   */
  recoverAt?: number;
  /** Lowest observed milliseconds per output token: the uncongested floor. */
  minMsPerToken?: number;
  /** Consecutive first-attempt samples above the delay threshold. */
  delayStreak?: number;
}

/**
 * - `ack`: externally verified (or, without a verifier, non-empty) first-attempt success.
 * - `retry_ack`: success that needed a retry; ambiguous like a retransmitted
 *   segment under Karn's algorithm, so it is counted but never grows.
 * - `task_loss`: the work itself failed (check failed, empty, generic error).
 * - `congestion`: overload evidence while other work still completes; halve once per window.
 * - `timeout`: the path stopped answering; collapse to one and slow-start.
 */
export type AckSignal = "ack" | "retry_ack" | "task_loss" | "congestion" | "timeout";

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

export function createAckWindow(ceiling: number): AckWindow {
  return { mode: "aimd", cwnd: 1, ssthresh: ceiling, acks: 0, losses: 0, taskLosses: 0 };
}

export function windowCapacity(window: AckWindow, ceiling: number): number {
  return Math.max(1, Math.min(ceiling, Math.floor(window.cwnd)));
}

export interface SignalContext {
  at: number;
  /** When the settling work was dispatched; ties a loss to the window it was sent in. */
  requestedAt: number;
}

export function applyAckSignal(window: AckWindow, signal: AckSignal, ceiling: number, context: SignalContext): AckWindow {
  if (signal === "task_loss") return { ...window, taskLosses: window.taskLosses + 1 };
  if (signal === "retry_ack") return { ...window, acks: window.acks + 1 };
  if (signal === "ack") {
    const growth = window.cwnd < window.ssthresh ? 1 : 1 / window.cwnd;
    return { ...window, cwnd: Math.min(ceiling, window.cwnd + growth), acks: window.acks + 1 };
  }
  const sameWindow = window.recoverAt !== undefined && context.requestedAt <= window.recoverAt;
  if (signal === "congestion" && sameWindow) return { ...window, losses: window.losses + 1 };
  // RFC 5681: repeated timeouts for the same flight reset the window but hold ssthresh.
  if (signal === "timeout" && sameWindow) return { ...window, cwnd: 1, losses: window.losses + 1 };
  const half = Math.max(1, Math.floor(window.cwnd / 2));
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
}

export function msPerToken(evidence: Pick<SettlementEvidence, "durationMs" | "outputTokens">): number | undefined {
  const { durationMs, outputTokens } = evidence;
  if (durationMs === undefined || outputTokens === undefined || !Number.isFinite(durationMs) || durationMs <= 0 || outputTokens < 1) return undefined;
  return durationMs / outputTokens;
}

export function classifySettlement(evidence: SettlementEvidence, window: Pick<AckWindow, "minMsPerToken" | "delayStreak">): AckSignal {
  if (evidence.outcome === "failed") {
    const error = evidence.error ?? "";
    if (TIMEOUT_ERROR.test(error)) return "timeout";
    if (CONGESTION_ERROR.test(error)) return "congestion";
    return "task_loss";
  }
  if (evidence.verifyPassed === false) return "task_loss";
  if (evidence.verifyPassed === undefined && !evidence.result?.trim()) return "task_loss";
  if (evidence.attempt > 1) return "retry_ack";
  if (isDelayed(evidence, window) && (window.delayStreak ?? 0) + 1 >= DELAY_CONGESTION_STREAK) return "congestion";
  return "ack";
}

function isDelayed(evidence: Pick<SettlementEvidence, "durationMs" | "outputTokens">, window: Pick<AckWindow, "minMsPerToken">): boolean {
  const sample = msPerToken(evidence);
  return sample !== undefined && window.minMsPerToken !== undefined && sample > window.minMsPerToken * DELAY_CONGESTION_FACTOR;
}

/** Fold a delay sample into the floor and streak. Retried work is excluded (Karn). */
export function observeDelay(window: AckWindow, evidence: Pick<SettlementEvidence, "durationMs" | "outputTokens" | "attempt">): AckWindow {
  const sample = msPerToken(evidence);
  if (sample === undefined || evidence.attempt > 1) return window;
  const delayStreak = isDelayed(evidence, window) ? (window.delayStreak ?? 0) + 1 : 0;
  const minMsPerToken = window.minMsPerToken === undefined ? sample : Math.min(window.minMsPerToken, sample);
  return { ...window, minMsPerToken, delayStreak };
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
    && (window.delayStreak === undefined || count(window.delayStreak));
}
