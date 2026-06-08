import { describe, expect, it } from "vitest";

interface MockOptions {
  respondToTaskPing?: boolean;
  pendingTaskCount?: () => number;
}

function createMockPi(options: MockOptions = {}) {
  const sentMessages: Array<{ message: any; options?: any }> = [];
  const sentUserMessages: Array<{ message: string; options?: any }> = [];
  const eventHandlers = new Map<string, Array<(data: any) => void>>();
  const extensionHandlers = new Map<string, Array<(data: any, ctx: any) => unknown>>();

  const events = {
    emit(name: string, payload: any) {
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

  return { pi, sentMessages, sentUserMessages, emitExtension };
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
