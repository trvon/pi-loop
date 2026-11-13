import { describe, expect, it } from "vitest";
import {
  type AckSignal,
  type AckWindow,
  applyAckSignal,
  classifySettlement,
  createAckWindow,
  DELAY_CONGESTION_FACTOR,
  observeDelay,
  validateAckWindow,
  windowCapacity,
} from "../src/ack-window.js";

let clock = 0;
function apply(window: AckWindow, ceiling: number, ...signals: AckSignal[]): AckWindow {
  return signals.reduce((current, signal) => {
    clock += 10;
    return applyAckSignal(current, signal, ceiling, { at: clock, requestedAt: clock - 1 });
  }, window);
}

describe("ACK-clocked Reno window", () => {
  it("starts at one unit in flight and treats the ceiling as the slow-start threshold", () => {
    const window = createAckWindow(4);
    expect(window).toEqual({ mode: "aimd", cwnd: 1, ssthresh: 4, acks: 0, losses: 0, taskLosses: 0 });
    expect(windowCapacity(window, 4)).toBe(1);
  });

  it("grows one unit per ACK in slow start, then about one unit per window", () => {
    const slowStart = apply(createAckWindow(8), 8, "ack", "ack", "ack");
    expect(slowStart.cwnd).toBe(4);
    const avoidance = apply({ ...createAckWindow(8), cwnd: 4, ssthresh: 4 }, 8, "ack", "ack", "ack", "ack");
    expect(avoidance.cwnd).toBeGreaterThan(4.9);
    expect(avoidance.cwnd).toBeLessThan(5);
    expect(windowCapacity(avoidance, 8)).toBe(4);
  });

  it("halves on congestion and resets to one on timeout, like Reno", () => {
    const grown = apply(createAckWindow(8), 8, "ack", "ack", "ack", "ack", "ack");
    expect(grown.cwnd).toBe(6);
    expect(apply(grown, 8, "congestion")).toMatchObject({ cwnd: 3, ssthresh: 3, losses: 1 });
    expect(apply(grown, 8, "timeout")).toMatchObject({ cwnd: 1, ssthresh: 3, losses: 1 });
  });

  it("cuts once per window: congestion from work sent before the last cut is absorbed", () => {
    const grown = { ...createAckWindow(8), cwnd: 8, ssthresh: 8 };
    const cut = applyAckSignal(grown, "congestion", 8, { at: 100, requestedAt: 50 });
    expect(cut).toMatchObject({ cwnd: 4, recoverAt: 100 });
    const sameWindow = applyAckSignal(cut, "congestion", 8, { at: 110, requestedAt: 60 });
    expect(sameWindow).toMatchObject({ cwnd: 4, losses: 2 });
    const nextWindow = applyAckSignal(sameWindow, "congestion", 8, { at: 120, requestedAt: 105 });
    expect(nextWindow).toMatchObject({ cwnd: 2, recoverAt: 120 });
    const timeoutAlwaysCollapses = applyAckSignal(cut, "timeout", 8, { at: 130, requestedAt: 60 });
    expect(timeoutAlwaysCollapses.cwnd).toBe(1);
  });

  it("counts task failures without touching the window", () => {
    const grown = apply(createAckWindow(8), 8, "ack", "ack");
    const failed = apply(grown, 8, "task_loss", "task_loss");
    expect(failed).toMatchObject({ cwnd: grown.cwnd, ssthresh: grown.ssthresh, losses: 0, taskLosses: 2 });
  });

  it("does not grow from a success that needed a retry (Karn)", () => {
    const window = apply(createAckWindow(8), 8, "ack");
    const afterRetry = apply(window, 8, "retry_ack");
    expect(afterRetry.cwnd).toBe(window.cwnd);
    expect(afterRetry.acks).toBe(window.acks + 1);
  });

  it("never exceeds the ceiling", () => {
    const window = apply(createAckWindow(2), 2, "ack", "ack", "ack", "ack");
    expect(window.cwnd).toBe(2);
    expect(windowCapacity({ ...window, cwnd: 7.5 }, 3)).toBe(3);
  });
});

describe("settlement classification", () => {
  const noFloor = {};

  it("treats a passing verifier as the ACK and a failing one as a task loss", () => {
    expect(classifySettlement({ outcome: "completed", result: "", attempt: 1, verifyPassed: true }, noFloor)).toBe("ack");
    expect(classifySettlement({ outcome: "completed", result: "looks done", attempt: 1, verifyPassed: false }, noFloor)).toBe("task_loss");
    expect(classifySettlement({ outcome: "completed", result: "ok", attempt: 2, verifyPassed: true }, noFloor)).toBe("retry_ack");
  });

  it("falls back to a non-empty result only when no verifier was declared", () => {
    expect(classifySettlement({ outcome: "completed", result: "found 2 issues", attempt: 1 }, noFloor)).toBe("ack");
    expect(classifySettlement({ outcome: "completed", result: "   ", attempt: 1 }, noFloor)).toBe("task_loss");
  });

  it("separates overload and timeout errors from task errors", () => {
    expect(classifySettlement({ outcome: "failed", error: "HTTP 429 Too Many Requests", attempt: 1 }, noFloor)).toBe("congestion");
    expect(classifySettlement({ outcome: "failed", error: "server overloaded, try later", attempt: 1 }, noFloor)).toBe("congestion");
    expect(classifySettlement({ outcome: "failed", error: "request timed out after 600s", attempt: 1 }, noFloor)).toBe("timeout");
    expect(classifySettlement({ outcome: "failed", error: "TypeError: cannot read x", attempt: 1 }, noFloor)).toBe("task_loss");
    expect(classifySettlement({ outcome: "failed", attempt: 1 }, noFloor)).toBe("task_loss");
  });

  it("flags a verified success as congestion only after a run of slow samples", () => {
    const floor = { minMsPerToken: 20 };
    const fast = { outcome: "completed" as const, attempt: 1, verifyPassed: true, outputTokens: 100 };
    const slowDuration = 100 * 20 * DELAY_CONGESTION_FACTOR + 100;
    expect(classifySettlement({ ...fast, durationMs: 100 * 20 * DELAY_CONGESTION_FACTOR }, { ...floor, delayStreak: 1 })).toBe("ack");
    expect(classifySettlement({ ...fast, durationMs: slowDuration }, floor)).toBe("ack");
    expect(classifySettlement({ ...fast, durationMs: slowDuration }, { ...floor, delayStreak: 1 })).toBe("congestion");
    expect(classifySettlement({ ...fast, durationMs: 999_999 }, { delayStreak: 9 })).toBe("ack");
    expect(classifySettlement({ ...fast, durationMs: 999_999, outputTokens: 0 }, { ...floor, delayStreak: 9 })).toBe("ack");
  });

  it("tracks the delay floor from first attempts only", () => {
    const window = createAckWindow(8);
    const first = observeDelay(window, { durationMs: 3000, outputTokens: 100, attempt: 1 });
    expect(first.minMsPerToken).toBe(30);
    expect(observeDelay(first, { durationMs: 1000, outputTokens: 100, attempt: 2 }).minMsPerToken).toBe(30);
    expect(observeDelay(first, { durationMs: 1000, outputTokens: 100, attempt: 1 }).minMsPerToken).toBe(10);
    expect(observeDelay(first, { durationMs: 9000, outputTokens: 100, attempt: 1 }).minMsPerToken).toBe(30);
    expect(observeDelay(first, { durationMs: 1000, attempt: 1 })).toBe(first);
  });
});

describe("persisted window validation", () => {
  it("accepts well-formed windows and rejects malformed ones", () => {
    const valid = { mode: "aimd", cwnd: 2.5, ssthresh: 2, acks: 3, losses: 1, taskLosses: 2, recoverAt: 40, minMsPerToken: 12.5 };
    expect(validateAckWindow(valid, 4)).toBe(true);
    expect(validateAckWindow({ ...valid, recoverAt: undefined, minMsPerToken: undefined }, 4)).toBe(true);
    for (const bad of [
      { ...valid, cwnd: 0.5 },
      { ...valid, cwnd: 5 },
      { ...valid, ssthresh: 0 },
      { ...valid, acks: -1 },
      { ...valid, taskLosses: undefined },
      { ...valid, minMsPerToken: 0 },
      { ...valid, recoverAt: Number.NaN },
      { ...valid, mode: "cubic" },
      null,
    ]) expect(validateAckWindow(bad, 4)).toBe(false);
  });
});

describe("review regressions", () => {
  it("R5: repeated timeouts in one window reset cwnd but do not lower ssthresh again (RFC 5681)", () => {
    const grown = { ...createAckWindow(8), cwnd: 8, ssthresh: 8 };
    const first = applyAckSignal(grown, "timeout", 8, { at: 100, requestedAt: 50 });
    expect(first).toMatchObject({ cwnd: 1, ssthresh: 4, recoverAt: 100 });
    const second = applyAckSignal(first, "timeout", 8, { at: 110, requestedAt: 60 });
    expect(second).toMatchObject({ cwnd: 1, ssthresh: 4, losses: 2 });
    const nextWindow = applyAckSignal({ ...second, cwnd: 6 }, "timeout", 8, { at: 200, requestedAt: 150 });
    expect(nextWindow).toMatchObject({ cwnd: 1, ssthresh: 3 });
  });

  it("R7: one slow sample is not congestion; two consecutive slow samples are", () => {
    const floor = { ...createAckWindow(8), minMsPerToken: 20 };
    const slow = { outcome: "completed" as const, attempt: 1, verifyPassed: true, outputTokens: 100, durationMs: 100 * 20 * 3 };
    const fast = { ...slow, durationMs: 100 * 20 };
    expect(classifySettlement(slow, floor)).toBe("ack");
    const afterOne = observeDelay(floor, slow);
    expect(afterOne.delayStreak).toBe(1);
    expect(classifySettlement(slow, afterOne)).toBe("congestion");
    expect(observeDelay(afterOne, fast).delayStreak).toBe(0);
  });

  it("R7: a retried success is never classified as delay congestion (Karn)", () => {
    const primed = { ...createAckWindow(8), minMsPerToken: 20, delayStreak: 5 };
    expect(classifySettlement({ outcome: "completed", attempt: 2, verifyPassed: true, outputTokens: 100, durationMs: 999_999 }, primed)).toBe("retry_ack");
    expect(observeDelay(primed, { attempt: 2, outputTokens: 100, durationMs: 999_999 }).delayStreak).toBe(5);
  });
});
