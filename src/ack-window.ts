/**
 * ACK-clocked AIMD window (Jacobson & Karels 1988; Chiu & Jain 1989).
 *
 * The window bounds how much work may be in flight before external evidence
 * acknowledges it. It is pure and deterministic: identical signal sequences
 * produce identical windows, so pacing never depends on the model's own
 * judgement of whether it is finished.
 */

export interface AckWindow {
  mode: "aimd";
  /** Congestion window; fractional so additive increase accrues across ACKs. */
  cwnd: number;
  /** Slow-start threshold: below it each ACK adds one unit, above it ~1/cwnd. */
  ssthresh: number;
  acks: number;
  losses: number;
}

/**
 * - `ack`: externally observed success on a first attempt; grows the window.
 * - `retry_ack`: success that needed a retry. Like Karn's algorithm, it is
 *   ambiguous evidence about the path, so it is counted but never grows.
 * - `loss`: proved failure, spawn failure, or an empty result.
 */
export type AckSignal = "ack" | "retry_ack" | "loss";

export function createAckWindow(ceiling: number): AckWindow {
  return { mode: "aimd", cwnd: 1, ssthresh: ceiling, acks: 0, losses: 0 };
}

export function windowCapacity(window: AckWindow, ceiling: number): number {
  return Math.max(1, Math.min(ceiling, Math.floor(window.cwnd)));
}

export function applyAckSignal(window: AckWindow, signal: AckSignal, ceiling: number): AckWindow {
  if (signal === "loss") {
    const half = Math.max(1, Math.floor(window.cwnd / 2));
    return { ...window, cwnd: half, ssthresh: half, losses: window.losses + 1 };
  }
  if (signal === "retry_ack") return { ...window, acks: window.acks + 1 };
  const growth = window.cwnd < window.ssthresh ? 1 : 1 / window.cwnd;
  return { ...window, cwnd: Math.min(ceiling, window.cwnd + growth), acks: window.acks + 1 };
}

/** An empty completion is a loss: a missing result is not a successful one. */
export function classifySettlement(outcome: "completed" | "failed", result: string | undefined, attempt: number): AckSignal {
  if (outcome === "failed" || !result?.trim()) return "loss";
  return attempt > 1 ? "retry_ack" : "ack";
}

export function validateAckWindow(value: unknown, ceiling: number): value is AckWindow {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const window = value as Record<string, unknown>;
  const count = (field: unknown) => Number.isInteger(field) && Number(field) >= 0;
  return window.mode === "aimd"
    && typeof window.cwnd === "number" && Number.isFinite(window.cwnd) && window.cwnd >= 1 && window.cwnd <= ceiling
    && Number.isInteger(window.ssthresh) && Number(window.ssthresh) >= 1 && Number(window.ssthresh) <= ceiling
    && count(window.acks) && count(window.losses);
}
