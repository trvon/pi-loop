import { describe, expect, it } from "vitest";
import { createCtx, createMockPi, flushAsync } from "./helpers/mock-pi.js";

describe("harness state steering", () => {
  it("uses custom steer messages with triggerTurn instead of sendUserMessage when a loop wake is effective", async () => {
    const { pi, sentMessages, sentUserMessages, emitExtension } = createMockPi();
    const extension = await import("../src/index.js");
    extension.default(pi);

    const ctx = createCtx(false);
    await emitExtension("turn_start", null, ctx);

    pi.events.emit("loop:fire", {
      loopId: "42",
      prompt: "Run the next step",
      trigger: { type: "cron", schedule: "*/1 * * * *" },
      timestamp: Date.now(),
    });
    await flushAsync();

    expect(sentUserMessages).toHaveLength(0);
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].options).toEqual({ deliverAs: "steer", triggerTurn: true });
    expect(sentMessages[0].message.customType).toBe("pi-loop");
    expect(sentMessages[0].message.display).toBe(false);
  });

  it("does not deliver while idle if the harness reports pending queued messages, then force-flushes on agent_end", async () => {
    const { pi, sentMessages, emitExtension } = createMockPi();
    const extension = await import("../src/index.js");
    extension.default(pi);

    const busyQueueCtx = createCtx(true);
    await emitExtension("turn_start", null, busyQueueCtx);

    pi.events.emit("loop:fire", {
      loopId: "51",
      prompt: "Wait until queued work drains",
      trigger: { type: "cron", schedule: "*/5 * * * *" },
      timestamp: Date.now(),
      recurring: true,
    });
    await flushAsync();

    expect(sentMessages).toHaveLength(0);

    await emitExtension("agent_end", null, busyQueueCtx);
    await flushAsync();

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].options).toEqual({ deliverAs: "steer", triggerTurn: true });
    expect(sentMessages[0].message.content).toContain("Wait until queued work drains");
  });

  it("buffers while agent is running even if the harness has no pending messages yet", async () => {
    const { pi, sentMessages, emitExtension } = createMockPi();
    const extension = await import("../src/index.js");
    extension.default(pi);

    const ctx = createCtx(false);
    await emitExtension("turn_start", null, ctx);
    await emitExtension("agent_start", null, ctx);

    pi.events.emit("loop:fire", {
      loopId: "52",
      prompt: "Wait for running agent",
      trigger: { type: "event", source: "tool_execution_end" },
      timestamp: Date.now(),
      recurring: false,
    });
    await flushAsync();

    expect(sentMessages).toHaveLength(0);

    await emitExtension("agent_end", null, ctx);
    await flushAsync();

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].options).toEqual({ deliverAs: "steer", triggerTurn: true });
    expect(sentMessages[0].message.content).toContain("Wait for running agent");
  });

  it("clears buffered wakes on session_switch so stale steering is not delivered into the next session", async () => {
    const { pi, sentMessages, emitExtension } = createMockPi();
    const extension = await import("../src/index.js");
    extension.default(pi);

    const ctx = createCtx(false);
    await emitExtension("turn_start", null, ctx);
    await emitExtension("agent_start", null, ctx);

    pi.events.emit("loop:fire", {
      loopId: "61",
      prompt: "Should be cleared on switch",
      trigger: { type: "cron", schedule: "*/5 * * * *" },
      timestamp: Date.now(),
      recurring: true,
    });
    await flushAsync();
    expect(sentMessages).toHaveLength(0);

    await emitExtension("session_switch", { reason: "switch" }, ctx);
    await emitExtension("agent_end", null, ctx);
    await flushAsync();

    expect(sentMessages).toHaveLength(0);
  });

  it("clears buffered wakes on session_shutdown so stale steering is dropped", async () => {
    const { pi, sentMessages, emitExtension } = createMockPi();
    const extension = await import("../src/index.js");
    extension.default(pi);

    const ctx = createCtx(false);
    await emitExtension("turn_start", null, ctx);
    await emitExtension("agent_start", null, ctx);

    pi.events.emit("loop:fire", {
      loopId: "62",
      prompt: "Should be cleared on shutdown",
      trigger: { type: "cron", schedule: "*/5 * * * *" },
      timestamp: Date.now(),
      recurring: true,
    });
    await flushAsync();
    expect(sentMessages).toHaveLength(0);

    await emitExtension("session_shutdown", null, ctx);
    await emitExtension("agent_end", null, ctx);
    await flushAsync();

    expect(sentMessages).toHaveLength(0);
  });
});
