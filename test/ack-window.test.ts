import { describe, expect, it } from "vitest";
import {
  type AckSignal,
  type AckWindow,
  ADMISSION_BACKOFF,
  applyAckSignal,
  CONGESTION_BACKOFF,
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
  it("treats the ceiling as the slow-start threshold", () => {
    const window = createAckWindow(4);
    expect(window).toEqual({ mode: "aimd", cwnd: 3, ssthresh: 4, acks: 0, losses: 0, taskLosses: 0 });
    expect(windowCapacity(window, 4)).toBe(3);
  });

  it("starts at the fixed-pacing default of three, or the batch size if smaller (RFC 6928 initial window)", () => {
    expect(createAckWindow(8)).toMatchObject({ cwnd: 3, ssthresh: 8 });
    expect(createAckWindow(2)).toMatchObject({ cwnd: 2, ssthresh: 2 });
    expect(createAckWindow(1)).toMatchObject({ cwnd: 1, ssthresh: 1 });
    expect(windowCapacity(createAckWindow(32), 32)).toBe(3);
  });

  it("grows one unit per ACK in slow start, then about one unit per window", () => {
    const slowStart = apply({ ...createAckWindow(8), cwnd: 1 }, 8, "ack", "ack", "ack");
    expect(slowStart.cwnd).toBe(4);
    const avoidance = apply({ ...createAckWindow(8), cwnd: 4, ssthresh: 4 }, 8, "ack", "ack", "ack", "ack");
    expect(avoidance.cwnd).toBeGreaterThan(4.9);
    expect(avoidance.cwnd).toBeLessThan(5);
    expect(windowCapacity(avoidance, 8)).toBe(4);
  });

  it("halves on congestion and resets to one on timeout, like Reno", () => {
    const grown = apply({ ...createAckWindow(8), cwnd: 1 }, 8, "ack", "ack", "ack", "ack", "ack");
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
    const floor = { delayFloors: { "2": 20 } };
    const fast = { outcome: "completed" as const, attempt: 1, verifyPassed: true, outputTokens: 100, toolUses: 6 };
    const slowDuration = 100 * 20 * DELAY_CONGESTION_FACTOR + 100;
    expect(classifySettlement({ ...fast, durationMs: 100 * 20 * DELAY_CONGESTION_FACTOR }, { ...floor, delayRuns: { "2": 1 } })).toBe("ack");
    expect(classifySettlement({ ...fast, durationMs: slowDuration }, floor)).toBe("ack");
    expect(classifySettlement({ ...fast, durationMs: slowDuration }, { ...floor, delayRuns: { "2": 1 } })).toBe("congestion");
    // A run already reported is not reported again.
    expect(classifySettlement({ ...fast, durationMs: slowDuration }, { ...floor, delayRuns: { "2": 2 } })).toBe("delayed_ack");
    // Another class's run does not count toward this one.
    expect(classifySettlement({ ...fast, durationMs: slowDuration }, { ...floor, delayRuns: { "0": 1 } })).toBe("ack");
    expect(classifySettlement({ ...fast, durationMs: 999_999 }, { delayRuns: { "2": 1 } })).toBe("ack");
    expect(classifySettlement({ ...fast, durationMs: 999_999, outputTokens: 0 }, { ...floor, delayRuns: { "2": 1 } })).toBe("ack");
  });

  it("tracks the delay floor from first attempts only", () => {
    const window = createAckWindow(8);
    const first = observeDelay(window, { durationMs: 3000, outputTokens: 100, attempt: 1, toolUses: 6 });
    expect(first.delayFloors).toEqual({ "2": 30 });
    expect(observeDelay(first, { durationMs: 1000, outputTokens: 100, attempt: 2, toolUses: 6 }).delayFloors).toEqual({ "2": 30 });
    expect(observeDelay(first, { durationMs: 1000, outputTokens: 100, attempt: 1, toolUses: 6 }).delayFloors).toEqual({ "2": 10 });
    expect(observeDelay(first, { durationMs: 9000, outputTokens: 100, attempt: 1, toolUses: 6 }).delayFloors).toEqual({ "2": 30 });
    expect(observeDelay(first, { durationMs: 1000, attempt: 1, toolUses: 6 })).toBe(first);
    // Another tool-use class keeps its own floor.
    expect(observeDelay(first, { durationMs: 1000, outputTokens: 100, attempt: 1, toolUses: 0 }).delayFloors).toEqual({ "0": 10, "2": 30 });
  });
});

describe("persisted window validation", () => {
  it("accepts well-formed windows and rejects malformed ones", () => {
    const valid = { mode: "aimd", cwnd: 2.5, ssthresh: 2, acks: 3, losses: 1, taskLosses: 2, recoverAt: 40, minMsPerToken: 12.5, delayFloors: { "0": 9.5, "3": 40 }, delayRuns: { "0": 0, "3": 3 }, delayStreak: 4 };
    expect(validateAckWindow(valid, 4)).toBe(true);
    expect(validateAckWindow({ ...valid, recoverAt: undefined, minMsPerToken: undefined, delayFloors: undefined }, 4)).toBe(true);
    // A window persisted before per-class floors carries only the single floor.
    expect(validateAckWindow({ ...valid, delayFloors: undefined }, 4)).toBe(true);
    for (const bad of [
      { ...valid, cwnd: 0.5 },
      { ...valid, cwnd: 5 },
      { ...valid, ssthresh: 0 },
      { ...valid, acks: -1 },
      { ...valid, taskLosses: undefined },
      { ...valid, minMsPerToken: 0 },
      { ...valid, delayFloors: { "0": 0 } },
      { ...valid, delayFloors: { "4": 10 } },
      { ...valid, delayFloors: [10] },
      { ...valid, delayRuns: { "0": -1 } },
      { ...valid, delayRuns: { "0": 9 } },
      { ...valid, delayRuns: { "7": 1 } },
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
    const floor = { ...createAckWindow(8), delayFloors: { "2": 20 } };
    const slow = { outcome: "completed" as const, attempt: 1, verifyPassed: true, outputTokens: 100, durationMs: 100 * 20 * 3, toolUses: 6 };
    const fast = { ...slow, durationMs: 100 * 20 };
    expect(classifySettlement(slow, floor)).toBe("ack");
    const afterOne = observeDelay(floor, slow);
    expect(afterOne.delayRuns).toEqual({ "2": 1 });
    expect(classifySettlement(slow, afterOne)).toBe("congestion");
    expect(observeDelay(afterOne, fast).delayRuns).toEqual({ "2": 0 });
  });

  it("R7: a retried success is never classified as delay congestion (Karn)", () => {
    const primed = { ...createAckWindow(8), delayFloors: { "2": 20 }, delayRuns: { "2": 1 } };
    expect(classifySettlement({ outcome: "completed", attempt: 2, verifyPassed: true, outputTokens: 100, durationMs: 999_999, toolUses: 6 }, primed)).toBe("retry_ack");
    expect(observeDelay(primed, { attempt: 2, outputTokens: 100, durationMs: 999_999, toolUses: 6 }).delayRuns).toEqual({ "2": 1 });
  });
});

describe("split multiplicative decrease", () => {
  const grown = { ...createAckWindow(16), cwnd: 10, ssthresh: 16 };

  it("S1: a rejection at admission cuts the window by ADMISSION_BACKOFF; no work was lost", () => {
    expect(ADMISSION_BACKOFF).toBe(0.7);
    expect(applyAckSignal(grown, "congestion", 16, { at: 100, requestedAt: 50, rejected: true })).toMatchObject({ cwnd: 7, ssthresh: 7, losses: 1 });
  });

  it("S2: congestion that lost work in flight still halves", () => {
    expect(CONGESTION_BACKOFF).toBe(0.5);
    expect(applyAckSignal(grown, "congestion", 16, { at: 100, requestedAt: 50 })).toMatchObject({ cwnd: 5, ssthresh: 5 });
  });

  it("S3: a rejected timeout still collapses to one and a rejection never cuts below one", () => {
    expect(applyAckSignal(grown, "timeout", 16, { at: 100, requestedAt: 50, rejected: true })).toMatchObject({ cwnd: 1, ssthresh: 5 });
    expect(applyAckSignal({ ...grown, cwnd: 1 }, "congestion", 16, { at: 100, requestedAt: 50, rejected: true })).toMatchObject({ cwnd: 1, ssthresh: 1 });
  });
});

describe("delay signal comparability", () => {
  const settle = (window: AckWindow, at: number, msPerToken: number, toolUses: number | undefined) => {
    const evidence = { outcome: "completed" as const, result: "ok", attempt: 1, durationMs: msPerToken * 1000, outputTokens: 1000, toolUses };
    const signal = classifySettlement(evidence, window);
    return { signal, window: observeDelay(applyAckSignal(window, signal, 8, { at, requestedAt: at - 1 }), evidence) };
  };
  const run = (samples: Array<[msPerToken: number, toolUses: number | undefined]>) => {
    let window = createAckWindow(8);
    const signals: AckSignal[] = [];
    for (const [index, [msPerToken, toolUses]] of samples.entries()) {
      const step = settle(window, (index + 1) * 1000, msPerToken, toolUses);
      window = step.window;
      signals.push(step.signal);
    }
    return { window, signals };
  };

  it("D1: one cheap tool-less answer does not make tool-heavy work read as congestion", () => {
    // An uncongested mixed batch: duration includes the worker's own tool time.
    const { window, signals } = run([[30, 0], [120, 9], [95, 7], [140, 12], [110, 8], [100, 9], [130, 11], [90, 6]]);
    expect(signals).not.toContain("congestion");
    expect(window.losses).toBe(0);
    expect(windowCapacity(window, 8)).toBe(8);
  });

  it("D2: one run of slow samples cuts once, not on every later slow sample", () => {
    const { window, signals } = run([[20, 6], [60, 6], [60, 6], [60, 6]]);
    expect(signals).toEqual(["ack", "ack", "congestion", "delayed_ack"]);
    expect(window.losses).toBe(1);
  });

  it("D6: a slow run that continues cuts once and does not grow; it can cut again only after comparable work was fast", () => {
    const first = run([[20, 6], [60, 6], [60, 6], [60, 6], [60, 6], [60, 6]]);
    expect(first.signals).toEqual(["ack", "ack", "congestion", "delayed_ack", "delayed_ack", "delayed_ack"]);
    expect(first.window.losses).toBe(1);
    const afterCut = run([[20, 6], [60, 6], [60, 6]]).window.cwnd;
    expect(first.window.cwnd).toBe(afterCut);

    const second = run([[20, 6], [60, 6], [60, 6], [60, 6], [22, 6], [60, 6], [60, 6]]);
    expect(second.signals).toEqual(["ack", "ack", "congestion", "delayed_ack", "ack", "ack", "congestion"]);
    expect(second.window.losses).toBe(2);
  });

  it("D7: slow runs are tracked per tool-use class, so unrelated work neither completes nor clears one", () => {
    // One slow sample in each of two classes is not two consecutive slow samples.
    expect(run([[20, 6], [10, 0], [60, 6], [30, 0]]).signals).toEqual(["ack", "ack", "ack", "ack"]);
    // A fast tool-less sample does not end the tool-heavy class's slow run.
    const interleaved = run([[20, 6], [10, 0], [60, 6], [10, 0], [60, 6]]);
    expect(interleaved.signals).toEqual(["ack", "ack", "ack", "ack", "congestion"]);
    expect(interleaved.window.losses).toBe(1);
  });

  it("D3 (control): comparable work that slows down is still congestion", () => {
    const { window, signals } = run([[20, 6], [22, 7], [60, 6], [65, 8]]);
    expect(signals).toEqual(["ack", "ack", "ack", "congestion"]);
    expect(window).toMatchObject({ losses: 1, cwnd: 3, ssthresh: 3 });
  });

  it("D4: without a tool-use count there is no delay evidence", () => {
    const { window, signals } = run([[20, undefined], [60, undefined], [60, undefined], [60, undefined]]);
    expect(signals).toEqual(["ack", "ack", "ack", "ack"]);
    expect(window.losses).toBe(0);
  });

  it("D5: a sample is compared only with work of a similar tool-use count", () => {
    // Tool-less 20, light 40, heavy 100: each is its own floor, so none is delayed.
    const { signals } = run([[20, 0], [40, 2], [100, 20], [22, 0], [44, 3], [105, 24]]);
    expect(signals).not.toContain("congestion");
  });
});
