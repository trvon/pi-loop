import { describe, expect, it } from "vitest";
import { createCtx, createMockPi, flushAsync } from "./helpers/mock-pi.js";

describe("loop:fire custom message delivery", () => {
  it("injects a custom pi-loop message immediately when idle", async () => {
    const { pi, sentMessages, sentUserMessages, emitExtension } = createMockPi();
    const extension = await import("../src/index.js");
    extension.default(pi);

    const ctx = createCtx(false);
    await emitExtension("turn_start", null, ctx);

    pi.events.emit("loop:fire", {
      loopId: "42",
      prompt: "Pick up the next task and work on it",
      trigger: { type: "cron", schedule: "*/1 * * * *" },
      timestamp: Date.now(),
      recurring: true,
    });
    await flushAsync();

    expect(sentUserMessages).toHaveLength(0);
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].options).toEqual({ deliverAs: "steer", triggerTurn: true });
    expect(sentMessages[0].message.customType).toBe("pi-loop");
    expect(sentMessages[0].message.display).toBe(false);
    expect(sentMessages[0].message.content).toContain("[pi-loop]");
    expect(sentMessages[0].message.content).toContain("Loop #42 fired");
    expect(sentMessages[0].message.content).toContain("Pick up the next task and work on it");
    expect(sentMessages[0].message.content).toContain("remains active after this iteration");
    expect(sentMessages[0].message.content).toContain("Do not call LoopDelete or pause it");
    expect(sentMessages[0].message.content).toContain("found no changes");
  });

  it("renders dynamic loop progress and LoopUpdate guidance", async () => {
    const { pi, sentMessages, emitExtension } = createMockPi();
    const extension = await import("../src/index.js");
    extension.default(pi);

    const ctx = createCtx(false);
    await emitExtension("turn_start", null, ctx);

    pi.events.emit("loop:fire", {
      loopId: "5",
      prompt: "finish dynamic loops",
      trigger: { type: "dynamic" },
      timestamp: Date.now(),
      recurring: true,
      dynamic: {
        goal: "finish dynamic loops",
        state: "router done",
        metrics: "2/5 tasks complete",
        doneCriteria: "all tasks done",
        iteration: 2,
      },
    });
    await flushAsync();

    expect(sentMessages).toHaveLength(1);
    const content = sentMessages[0].message.content;
    expect(content).toContain("Loop #5 fired (dynamic)");
    expect(content).toContain("Goal: finish dynamic loops");
    expect(content).toContain("State: router done");
    expect(content).toContain("Metrics: 2/5 tasks complete");
    expect(content).toContain("LoopUpdate");
    expect(content).toContain("idle-driven rewake");
    expect(content).toContain("persistent controller for the overall goal");
    expect(content).toContain("Do not call LoopDelete after this iteration");
    expect(content).toContain("call LoopUpdate exactly once");
    expect(content).toContain("only when the overall goal and done criteria are satisfied");
  });

  it("keeps backlog cleanup under pi-loop control", async () => {
    const { pi, sentMessages, emitExtension } = createMockPi();
    const extension = await import("../src/index.js");
    extension.default(pi);

    const ctx = createCtx(false);
    await emitExtension("turn_start", null, ctx);

    pi.events.emit("loop:fire", {
      loopId: "6",
      prompt: "Process the pending task backlog",
      trigger: { type: "event", source: "tasks:created" },
      timestamp: Date.now(),
      recurring: true,
      taskBacklog: true,
    });
    await flushAsync();

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].message.content).toContain("managed automatically");
    expect(sentMessages[0].message.content).toContain("Do not call LoopDelete");
    expect(sentMessages[0].message.content).toContain("report that and end this iteration");
    expect(sentMessages[0].message.details.taskBacklog).toBe(true);
  });

  it("includes the read-only constraint without advertising LoopCreate", async () => {
    const { pi, sentMessages, emitExtension } = createMockPi();
    const extension = await import("../src/index.js");
    extension.default(pi);

    const ctx = createCtx(false);
    await emitExtension("turn_start", null, ctx);

    pi.events.emit("loop:fire", {
      loopId: "7",
      prompt: "Check the build status",
      trigger: { type: "cron", schedule: "*/5 * * * *" },
      timestamp: Date.now(),
      readOnly: true,
    });
    await flushAsync();

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].message.content).toContain("READ-ONLY MODE");
    expect(sentMessages[0].message.content).toContain("MonitorList");
    expect(sentMessages[0].message.content).not.toContain("LoopCreate");
  });

  it("buffers recurring fires while the agent is active and flushes once idle", async () => {
    const { pi, sentMessages, emitExtension } = createMockPi();
    const extension = await import("../src/index.js");
    extension.default(pi);

    const ctx = createCtx(false);
    await emitExtension("turn_start", null, ctx);
    await emitExtension("agent_start", null, ctx);

    pi.events.emit("loop:fire", {
      loopId: "9",
      prompt: "Deliver after current work finishes",
      trigger: { type: "cron", schedule: "*/1 * * * *" },
      timestamp: Date.now(),
      recurring: true,
    });
    await flushAsync();
    expect(sentMessages).toHaveLength(0);

    await emitExtension("agent_end", null, ctx);
    await flushAsync();

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].message.content).toContain("Deliver after current work finishes");
  });

  it("dedupes buffered recurring fires by loop id and keeps the latest prompt", async () => {
    const { pi, sentMessages, emitExtension } = createMockPi();
    const extension = await import("../src/index.js");
    extension.default(pi);

    const ctx = createCtx(false);
    await emitExtension("turn_start", null, ctx);
    await emitExtension("agent_start", null, ctx);

    pi.events.emit("loop:fire", {
      loopId: "13",
      prompt: "Old prompt",
      trigger: { type: "cron", schedule: "*/1 * * * *" },
      timestamp: Date.now(),
      recurring: true,
    });
    pi.events.emit("loop:fire", {
      loopId: "13",
      prompt: "Latest prompt",
      trigger: { type: "cron", schedule: "*/1 * * * *" },
      timestamp: Date.now() + 1,
      recurring: true,
    });
    await flushAsync();

    await emitExtension("agent_end", null, ctx);
    await flushAsync();

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].message.content).toContain("Latest prompt");
    expect(sentMessages[0].message.content).not.toContain("Old prompt");
  });

  it("flushes one-shot monitor wakes after the current agent run", async () => {
    const { pi, sentMessages, emitExtension } = createMockPi();
    const extension = await import("../src/index.js");
    extension.default(pi);

    const ctx = createCtx(false);
    await emitExtension("turn_start", null, ctx);
    await emitExtension("agent_start", null, ctx);

    pi.events.emit("loop:fire", {
      loopId: "11",
      prompt: "Monitor completed — must deliver",
      trigger: { type: "event", source: "monitor:done" },
      timestamp: Date.now(),
      recurring: false,
    });
    await flushAsync();
    expect(sentMessages).toHaveLength(0);

    await emitExtension("agent_end", null, ctx);
    await flushAsync();

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].message.content).toContain("Monitor completed");
    expect(sentMessages[0].message.content).toContain("one-shot wake and cleanup is automatic");
    expect(sentMessages[0].message.content).toContain("Do not call LoopDelete");
  });

  it("keeps one-shot buffered wakes independent even for the same loop id", async () => {
    const { pi, sentMessages, emitExtension } = createMockPi();
    const extension = await import("../src/index.js");
    extension.default(pi);

    const ctx = createCtx(false);
    await emitExtension("turn_start", null, ctx);
    await emitExtension("agent_start", null, ctx);

    pi.events.emit("loop:fire", {
      loopId: "11",
      prompt: "First one-shot",
      trigger: { type: "event", source: "monitor:done" },
      timestamp: Date.now(),
      recurring: false,
    });
    pi.events.emit("loop:fire", {
      loopId: "11",
      prompt: "Second one-shot",
      trigger: { type: "event", source: "monitor:done" },
      timestamp: Date.now() + 1,
      recurring: false,
    });
    await flushAsync();

    expect(sentMessages).toHaveLength(0);

    await emitExtension("agent_end", null, ctx);
    await flushAsync();
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].message.content).toContain("First one-shot");

    await emitExtension("agent_end", null, ctx);
    await flushAsync();
    expect(sentMessages).toHaveLength(2);
    expect(sentMessages[1].message.content).toContain("Second one-shot");
  });

  it("clears buffered wakes on session switch", async () => {
    const { pi, sentMessages, emitExtension } = createMockPi();
    const extension = await import("../src/index.js");
    extension.default(pi);

    const ctx = createCtx(false);
    await emitExtension("turn_start", null, ctx);
    await emitExtension("agent_start", null, ctx);

    pi.events.emit("loop:fire", {
      loopId: "21",
      prompt: "Should be cleared on switch",
      trigger: { type: "cron", schedule: "*/5 * * * *" },
      timestamp: Date.now(),
      recurring: true,
    });
    await flushAsync();

    await emitExtension("session_switch", { reason: "switch" }, ctx);
    await emitExtension("agent_end", null, ctx);
    await flushAsync();

    expect(sentMessages).toHaveLength(0);
  });

  it("clears buffered wakes on session shutdown", async () => {
    const { pi, sentMessages, emitExtension } = createMockPi();
    const extension = await import("../src/index.js");
    extension.default(pi);

    const ctx = createCtx(false);
    await emitExtension("turn_start", null, ctx);
    await emitExtension("agent_start", null, ctx);

    pi.events.emit("loop:fire", {
      loopId: "22",
      prompt: "Should be cleared on shutdown",
      trigger: { type: "cron", schedule: "*/5 * * * *" },
      timestamp: Date.now(),
      recurring: true,
    });
    await flushAsync();

    await emitExtension("session_shutdown", null, ctx);
    await emitExtension("agent_end", null, ctx);
    await flushAsync();

    expect(sentMessages).toHaveLength(0);
  });

  it("drops a buffered autoTask wake when pending tasks reach zero before flush", async () => {
    let pendingTaskCount = 1;
    const { pi, sentMessages, emittedEvents, emitExtension } = createMockPi({
      respondToTaskPing: true,
      pendingTaskCount: () => pendingTaskCount,
    });
    const extension = await import("../src/index.js");
    extension.default(pi);
    await flushAsync();

    const ctx = createCtx(false);
    await emitExtension("turn_start", null, ctx);
    await emitExtension("agent_start", null, ctx);

    pi.events.emit("loop:fire", {
      loopId: "12",
      prompt: "Should be dropped before delivery",
      trigger: { type: "cron", schedule: "*/5 * * * *" },
      timestamp: Date.now(),
      autoTask: true,
      recurring: false,
    });
    await flushAsync();
    expect(sentMessages).toHaveLength(0);

    pendingTaskCount = 0;
    await emitExtension("agent_end", null, ctx);
    await flushAsync();

    expect(sentMessages).toHaveLength(0);
    expect(emittedEvents.some(event => event.name === "tasks:rpc:clean")).toBe(true);
  });
});
