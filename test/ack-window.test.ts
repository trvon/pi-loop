import { describe, expect, it } from "vitest";
import { type AckWindow, applyAckSignal, classifySettlement, createAckWindow, validateAckWindow, windowCapacity } from "../src/ack-window.js";

function apply(window: AckWindow, ceiling: number, ...signals: Parameters<typeof applyAckSignal>[1][]): AckWindow {
  return signals.reduce((current, signal) => applyAckSignal(current, signal, ceiling), window);
}

describe("ACK-clocked AIMD window", () => {
  it("starts at one unit in flight and treats the ceiling as the slow-start threshold", () => {
    const window = createAckWindow(4);
    expect(window).toEqual({ mode: "aimd", cwnd: 1, ssthresh: 4, acks: 0, losses: 0 });
    expect(windowCapacity(window, 4)).toBe(1);
  });

  it("grows one unit per ACK in slow start, then about one unit per window", () => {
    const slowStart = apply(createAckWindow(8), 8, "ack", "ack", "ack");
    expect(slowStart.cwnd).toBe(4);
    expect(windowCapacity(slowStart, 8)).toBe(4);

    const avoidance = apply({ mode: "aimd", cwnd: 4, ssthresh: 4, acks: 0, losses: 0 }, 8, "ack", "ack", "ack", "ack");
    expect(avoidance.cwnd).toBeGreaterThan(4.9);
    expect(avoidance.cwnd).toBeLessThan(5);
    expect(windowCapacity(avoidance, 8)).toBe(4);
  });

  it("halves on loss, never below one, and lowers the slow-start threshold", () => {
    const grown = apply(createAckWindow(8), 8, "ack", "ack", "ack", "ack", "ack");
    expect(grown.cwnd).toBe(6);
    const halved = applyAckSignal(grown, "loss", 8);
    expect(halved).toMatchObject({ cwnd: 3, ssthresh: 3, losses: 1 });
    const floor = apply(halved, 8, "loss", "loss", "loss");
    expect(floor).toMatchObject({ cwnd: 1, ssthresh: 1, losses: 4 });
    expect(windowCapacity(floor, 8)).toBe(1);
  });

  it("does not grow from a success that needed a retry (Karn)", () => {
    const window = apply(createAckWindow(8), 8, "ack");
    const afterRetry = applyAckSignal(window, "retry_ack", 8);
    expect(afterRetry.cwnd).toBe(window.cwnd);
    expect(afterRetry.acks).toBe(window.acks + 1);
  });

  it("never exceeds the configured concurrency ceiling", () => {
    const window = apply(createAckWindow(2), 2, "ack", "ack", "ack", "ack", "ack", "ack");
    expect(window.cwnd).toBe(2);
    expect(windowCapacity(window, 2)).toBe(2);
    expect(windowCapacity({ ...window, cwnd: 7.5 }, 3)).toBe(3);
  });

  it("classifies only externally observed, non-empty first-attempt completion as a growing ACK", () => {
    expect(classifySettlement("completed", "found 2 issues", 1)).toBe("ack");
    expect(classifySettlement("completed", "found 2 issues", 2)).toBe("retry_ack");
    expect(classifySettlement("completed", "   ", 1)).toBe("loss");
    expect(classifySettlement("completed", undefined, 1)).toBe("loss");
    expect(classifySettlement("failed", "partial", 1)).toBe("loss");
  });

  it("validates persisted windows against the ceiling", () => {
    expect(validateAckWindow({ mode: "aimd", cwnd: 2.5, ssthresh: 2, acks: 3, losses: 1 }, 4)).toBe(true);
    expect(validateAckWindow({ mode: "aimd", cwnd: 0.5, ssthresh: 2, acks: 0, losses: 0 }, 4)).toBe(false);
    expect(validateAckWindow({ mode: "aimd", cwnd: 5, ssthresh: 2, acks: 0, losses: 0 }, 4)).toBe(false);
    expect(validateAckWindow({ mode: "aimd", cwnd: 1, ssthresh: 0, acks: 0, losses: 0 }, 4)).toBe(false);
    expect(validateAckWindow({ mode: "aimd", cwnd: 1, ssthresh: 1, acks: -1, losses: 0 }, 4)).toBe(false);
    expect(validateAckWindow({ mode: "cubic", cwnd: 1, ssthresh: 1, acks: 0, losses: 0 }, 4)).toBe(false);
    expect(validateAckWindow(null, 4)).toBe(false);
  });
});
