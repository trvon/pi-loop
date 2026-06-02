import { describe, expect, it } from "vitest";

interface MockOptions {
  respondToTaskPing?: boolean;
  pendingTaskCount?: () => number;
}

function createMockPi(options: MockOptions = {}) {
  const sentMessages: Array<{ message: any; options?: any }> = [];
  const sentUserMessages: Array<{ message: string; options?: any }> = [];
  const emittedEvents: Array<{ name: string; payload: any }> = [];
  const eventHandlers = new Map<string, Array<(data: any) => void>>();
  const extensionHandlers = new Map<string, Array<(data: any, ctx: any) => unknown>>();

  const events = {
    emit(name: string, payload: any) {
      emittedEvents.push({ name, payload });

      if (name === "tasks:rpc:ping" && payload?.requestId && options.respondToTaskPing) {
        queueMicrotask(() => {
          events.emit(`tasks:rpc:ping:reply:${payload.requestId}`, {
            success: true,
            data: { version: 1 },
          });
        });
        return;
      }

      if (name === "tasks:rpc:pending" && payload?.requestId && options.pendingTaskCount) {
        queueMicrotask(() => {
          events.emit(`tasks:rpc:pending:reply:${payload.requestId}`, {
            success: true,
            data: { pending: options.pendingTaskCount?.() ?? 0 },
          });
        });
        return;
      }

      if (name === "tasks:rpc:clean" && payload?.requestId) {
        queueMicrotask(() => {
          events.emit(`tasks:rpc:clean:reply:${payload.requestId}`, { success: true });
        });
        return;
      }

      for (const cb of eventHandlers.get(name) ?? []) cb(payload);
    },
    on(name: string, handler: (data: any) => void) {
      const handlers = eventHandlers.get(name) ?? [];
      handlers.push(handler);
      eventHandlers.set(name, handlers);
      return () => {};
    },
  };

  const pi: any = {
    events,
    on(name: string, handler: (data: any, ctx: any) => unknown) {
      const handlers = extensionHandlers.get(name) ?? [];
      handlers.push(handler);
      extensionHandlers.set(name, handlers);
    },
    registerTool() {},
    registerCommand() {},
    sendMessage(message: any, options?: any) {
      sentMessages.push({ message, options });
    },
    sendUserMessage(message: string, options?: any) {
      sentUserMessages.push({ message, options });
    },
  };

  async function emitExtension(name: string, payload: any, ctx: any) {
    for (const handler of extensionHandlers.get(name) ?? []) {
      await handler(payload, ctx);
    }
  }

  return { pi, sentMessages, sentUserMessages, emittedEvents, emitExtension };
}

function createCtx(hasPendingMessages = false) {
  return {
    ui: { setStatus() {}, setWidget() {} },
    hasPendingMessages: () => hasPendingMessages,
    sessionManager: { getSessionId: () => "test-session" },
  };
}

async function flushAsync() {
  await new Promise(resolve => setTimeout(resolve, 0));
}

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
