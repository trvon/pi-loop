import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import extension from "../src/index.js";

interface RegisteredTool {
  name: string;
  execute?: (...args: any[]) => any;
}

interface RegisteredCommand {
  description?: string;
  handler?: (...args: any[]) => any;
}

function createMockPi(options?: { respondToTaskPing?: boolean }) {
  const toolMap = new Map<string, RegisteredTool>();
  const commandMap = new Map<string, RegisteredCommand>();
  const sentMessages: Array<{ message: string; options?: unknown }> = [];
  const sentCustomMessages: Array<{ message: unknown; options?: unknown }> = [];
  const eventHandlers = new Map<string, Set<(payload: unknown) => void>>();
  const extensionHandlers = new Map<string, Set<(payload: unknown, ctx: unknown) => void>>();

  const events = {
    on(name: string, cb: (payload: unknown) => void) {
      const handlers = eventHandlers.get(name) ?? new Set();
      handlers.add(cb);
      eventHandlers.set(name, handlers);
      return () => handlers.delete(cb);
    },
    emit(name: string, payload: any) {
      if (name === "tasks:rpc:ping" && options?.respondToTaskPing) {
        queueMicrotask(() => {
          events.emit(`tasks:rpc:ping:reply:${payload.requestId}`, { data: { version: 1 } });
        });
      }
      for (const cb of eventHandlers.get(name) ?? []) cb(payload);
    },
  };

  const pi = {
    events,
    on(name: string, cb: (payload: unknown, ctx: unknown) => void) {
      const handlers = extensionHandlers.get(name) ?? new Set();
      handlers.add(cb);
      extensionHandlers.set(name, handlers);
    },
    registerTool(tool: RegisteredTool) {
      toolMap.set(tool.name, tool);
    },
    registerCommand(name: string, command: RegisteredCommand) {
      commandMap.set(name, command);
    },
    sendMessage(message: unknown, options?: unknown) {
      sentCustomMessages.push({ message, options });
    },
    sendUserMessage(message: string, options?: unknown) {
      sentMessages.push({ message, options });
    },
  };

  return { pi, toolMap, commandMap, extensionHandlers, sentMessages, sentCustomMessages };
}

describe("native task fallback", () => {
  let cwd: string;
  let originalCwd: string;

  beforeEach(() => {
    vi.useFakeTimers();
    originalCwd = process.cwd();
    cwd = mkdtempSync(join(tmpdir(), "pi-loop-index-"));
    process.chdir(cwd);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(cwd, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it("registers native task tools when pi-tasks is unavailable", async () => {
    const { pi, toolMap, commandMap } = createMockPi();

    extension(pi as any);
    await vi.advanceTimersByTimeAsync(6100);
    await Promise.resolve();

    expect(toolMap.has("TaskCreate")).toBe(true);
    expect(toolMap.has("TaskList")).toBe(true);
    expect(toolMap.has("TaskUpdate")).toBe(true);
    expect(toolMap.has("TaskDelete")).toBe(true);
    expect(commandMap.has("tasks")).toBe(true);
  });

  it("does not register native task tools when pi-tasks responds", async () => {
    const { pi, toolMap, commandMap } = createMockPi({ respondToTaskPing: true });

    extension(pi as any);
    await vi.advanceTimersByTimeAsync(6100);
    await Promise.resolve();

    expect(toolMap.has("TaskCreate")).toBe(false);
    expect(toolMap.has("TaskList")).toBe(false);
    expect(toolMap.has("TaskUpdate")).toBe(false);
    expect(toolMap.has("TaskDelete")).toBe(false);
    expect(commandMap.has("tasks")).toBe(false);
  });

  it("stores native tasks in a dedicated .pi/tasks/tasks.json path", async () => {
    const { pi, toolMap } = createMockPi();

    extension(pi as any);
    await vi.advanceTimersByTimeAsync(6100);
    await Promise.resolve();

    const taskCreate = toolMap.get("TaskCreate");
    expect(taskCreate?.execute).toBeDefined();

    await taskCreate!.execute?.("1", { subject: "Test task", description: "Native fallback path" });

    const taskPath = join(cwd, ".pi", "tasks", "tasks.json");
    expect(existsSync(taskPath)).toBe(true);

    const data = JSON.parse(readFileSync(taskPath, "utf-8"));
    expect(data.tasks).toHaveLength(1);
    expect(data.tasks[0].subject).toBe("Test task");
  });

  it("quick-creates native tasks through the /tasks command", async () => {
    const { pi, commandMap } = createMockPi();

    extension(pi as any);
    await vi.advanceTimersByTimeAsync(6100);
    await Promise.resolve();

    const tasksCommand = commandMap.get("tasks");
    expect(tasksCommand?.handler).toBeDefined();

    const ui = { notify: vi.fn() };
    await tasksCommand!.handler?.("Write README updates", { ui });

    const taskPath = join(cwd, ".pi", "tasks", "tasks.json");
    const data = JSON.parse(readFileSync(taskPath, "utf-8"));
    expect(data.tasks).toHaveLength(1);
    expect(data.tasks[0].subject).toBe("Write README updates");
    expect(data.tasks[0].description).toBe("Write README updates");
    expect(ui.notify).toHaveBeenCalledWith("Task #1 created", "info");
  });

  it("emits tasks:created when native tasks are created", async () => {
    const { pi, toolMap } = createMockPi();
    const seen: Array<Record<string, unknown>> = [];
    pi.events.on("tasks:created", (payload) => {
      seen.push(payload as Record<string, unknown>);
    });

    extension(pi as any);
    await vi.advanceTimersByTimeAsync(6100);
    await Promise.resolve();

    const taskCreate = toolMap.get("TaskCreate");
    expect(taskCreate?.execute).toBeDefined();

    await taskCreate!.execute?.("1", { subject: "Emit event", description: "Native task event" });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      subject: "Emit event",
      description: "Native task event",
      status: "pending",
    });
  });

  it("wakes immediately when a recurring tasks:created loop is bootstrapped against existing pending tasks", async () => {
    const { pi, toolMap, sentCustomMessages } = createMockPi();

    extension(pi as any);
    await vi.advanceTimersByTimeAsync(6100);
    await Promise.resolve();

    const taskCreate = toolMap.get("TaskCreate");
    const loopCreate = toolMap.get("LoopCreate");
    expect(taskCreate?.execute).toBeDefined();
    expect(loopCreate?.execute).toBeDefined();

    await taskCreate!.execute?.("1", { subject: "Existing task", description: "Created before loop" });

    const result = await loopCreate!.execute?.("2", {
      trigger: "tasks:created",
      prompt: "Pick the next pending task and work on it",
      triggerType: "event",
      recurring: true,
    });

    expect(result.content[0].text).toContain("Bootstrap: queued initial wake for existing pending tasks");
    expect(sentCustomMessages).toHaveLength(1);
    expect(sentCustomMessages[0].options).toEqual({ deliverAs: "steer", triggerTurn: true });
    expect((sentCustomMessages[0].message as { content: string }).content).toContain("Pick the next pending task and work on it");
  });

  it("wakes when a future native task creation matches a recurring tasks:created loop", async () => {
    const { pi, toolMap, sentCustomMessages } = createMockPi();

    extension(pi as any);
    await vi.advanceTimersByTimeAsync(6100);
    await Promise.resolve();

    const loopCreate = toolMap.get("LoopCreate");
    const taskCreate = toolMap.get("TaskCreate");
    expect(loopCreate?.execute).toBeDefined();
    expect(taskCreate?.execute).toBeDefined();

    await loopCreate!.execute?.("1", {
      trigger: "tasks:created",
      prompt: "Start work on the new task",
      triggerType: "event",
      recurring: true,
    });
    expect(sentCustomMessages).toHaveLength(0);

    await taskCreate!.execute?.("2", { subject: "Future task", description: "Created after loop" });
    await Promise.resolve();

    expect(sentCustomMessages).toHaveLength(1);
    expect((sentCustomMessages[0].message as { content: string }).content).toContain("Start work on the new task");
  });

  it("auto-creates native tasks when an event-triggered autoTask loop fires", async () => {
    const { pi, toolMap } = createMockPi();

    extension(pi as any);
    await vi.advanceTimersByTimeAsync(6100);
    await Promise.resolve();

    const loopCreate = toolMap.get("LoopCreate");
    expect(loopCreate?.execute).toBeDefined();

    await loopCreate!.execute?.("1", {
      trigger: "native:test:event",
      prompt: "Follow up on native task work",
      triggerType: "event",
      autoTask: true,
    });

    pi.events.emit("native:test:event", {});
    await Promise.resolve();

    const taskPath = join(cwd, ".pi", "tasks", "tasks.json");
    const data = JSON.parse(readFileSync(taskPath, "utf-8"));
    expect(data.tasks).toHaveLength(1);
    expect(data.tasks[0].subject).toBe("Follow up on native task work");
    expect(data.tasks[0].description).toContain("Auto-created from loop #");
    expect(data.tasks[0].metadata.loopId).toBe("1");
  });

  it("sweeps completed native tasks and skips follow-up wake when no tasks remain", async () => {
    const { pi, toolMap, sentMessages } = createMockPi();

    extension(pi as any);
    await vi.advanceTimersByTimeAsync(6100);
    await Promise.resolve();

    const taskCreate = toolMap.get("TaskCreate");
    const taskUpdate = toolMap.get("TaskUpdate");
    expect(taskCreate?.execute).toBeDefined();
    expect(taskUpdate?.execute).toBeDefined();

    await taskCreate!.execute?.("1", { subject: "Done task", description: "already finished" });
    await taskUpdate!.execute?.("2", { id: "1", status: "completed" });

    pi.events.emit("loop:fire", {
      loopId: "99",
      prompt: "Should not wake agent",
      trigger: { type: "event", source: "native:test:event" },
      timestamp: Date.now(),
      autoTask: true,
      recurring: false,
    });
    await Promise.resolve();

    const taskPath = join(cwd, ".pi", "tasks", "tasks.json");
    const data = JSON.parse(readFileSync(taskPath, "utf-8"));
    expect(data.tasks).toHaveLength(0);
    expect(sentMessages).toHaveLength(0);
  });

  it("drops a buffered native autoTask wake when tasks finish before agent_end", async () => {
    const { pi, toolMap, extensionHandlers, sentCustomMessages, sentMessages } = createMockPi();

    extension(pi as any);
    await vi.advanceTimersByTimeAsync(6100);
    await Promise.resolve();

    const taskCreate = toolMap.get("TaskCreate");
    const taskUpdate = toolMap.get("TaskUpdate");
    expect(taskCreate?.execute).toBeDefined();
    expect(taskUpdate?.execute).toBeDefined();

    await taskCreate!.execute?.("1", { subject: "Buffered task", description: "will complete before flush" });

    const ctx = {
      ui: { setStatus: vi.fn(), setWidget: vi.fn() },
      hasPendingMessages: () => false,
      sessionManager: { getSessionId: () => "test-session" },
    };

    for (const handler of extensionHandlers.get("turn_start") ?? []) {
      await handler(null, ctx);
    }
    for (const handler of extensionHandlers.get("agent_start") ?? []) {
      await handler(null, ctx);
    }

    pi.events.emit("loop:fire", {
      loopId: "100",
      prompt: "Should be canceled before flush",
      trigger: { type: "event", source: "native:test:event" },
      timestamp: Date.now(),
      autoTask: true,
      recurring: false,
    });
    await Promise.resolve();

    expect(sentCustomMessages).toHaveLength(0);
    expect(sentMessages).toHaveLength(0);

    await taskUpdate!.execute?.("2", { id: "1", status: "completed" });

    for (const handler of extensionHandlers.get("agent_end") ?? []) {
      await handler(null, ctx);
    }
    await Promise.resolve();

    const taskPath = join(cwd, ".pi", "tasks", "tasks.json");
    const data = JSON.parse(readFileSync(taskPath, "utf-8"));
    expect(data.tasks).toHaveLength(0);
    expect(sentCustomMessages).toHaveLength(0);
    expect(sentMessages).toHaveLength(0);
  });

  it("removes recurring event loops immediately after the final allowed fire", async () => {
    const { pi, toolMap } = createMockPi();

    extension(pi as any);
    await vi.advanceTimersByTimeAsync(6100);
    await Promise.resolve();

    const loopCreate = toolMap.get("LoopCreate");
    const loopList = toolMap.get("LoopList");
    expect(loopCreate?.execute).toBeDefined();
    expect(loopList?.execute).toBeDefined();

    await loopCreate!.execute?.("1", {
      trigger: "maxfires:test:event",
      prompt: "Fire once then disappear",
      triggerType: "event",
      recurring: true,
      maxFires: 1,
    });

    pi.events.emit("maxfires:test:event", {});
    await Promise.resolve();

    const result = await loopList!.execute?.("2", {});
    expect(result.content[0].text).toBe("No loops configured. Use LoopCreate to set up a schedule.");
  });
});

describe("dynamic loop pump", () => {
  let cwd: string;
  let originalCwd: string;

  beforeEach(() => {
    vi.useFakeTimers();
    originalCwd = process.cwd();
    cwd = mkdtempSync(join(tmpdir(), "pi-loop-pump-"));
    process.chdir(cwd);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(cwd, { recursive: true, force: true });
    vi.useRealTimers();
  });

  function makeCtx() {
    return {
      ui: { setStatus: vi.fn(), setWidget: vi.fn() },
      hasPendingMessages: () => false,
      sessionManager: { getSessionId: () => "test-session" },
    };
  }

  it("pump fires cron loops on agent_end when next fire time has passed", async () => {
    const { pi, toolMap, extensionHandlers, sentCustomMessages } = createMockPi();

    extension(pi as any);
    await vi.advanceTimersByTimeAsync(6100);
    await Promise.resolve();

    const ctx = makeCtx();
    for (const handler of extensionHandlers.get("turn_start") ?? []) {
      await handler(null, ctx);
    }
    for (const handler of extensionHandlers.get("before_agent_start") ?? []) {
      await handler(null, ctx);
    }

    const loopCreate = toolMap.get("LoopCreate");
    expect(loopCreate?.execute).toBeDefined();

    await loopCreate!.execute?.("1", {
      trigger: "*/5 * * * *",
      prompt: "Dynamic idle fire",
      triggerType: "cron",
      recurring: true,
    });

    vi.advanceTimersByTime(6 * 60 * 1000);
    expect(sentCustomMessages).toHaveLength(0);

    for (const handler of extensionHandlers.get("agent_start") ?? []) {
      await handler(null, ctx);
    }

    for (const handler of extensionHandlers.get("agent_end") ?? []) {
      await handler(null, ctx);
    }
    await Promise.resolve();

    expect(sentCustomMessages).toHaveLength(1);
    expect(sentCustomMessages[0].options).toEqual({ deliverAs: "steer", triggerTurn: true });
    expect((sentCustomMessages[0].message as { content: string }).content).toContain("Dynamic idle fire");
  });

  it("pump does not fire when next fire time has not been reached", async () => {
    const { pi, toolMap, extensionHandlers, sentCustomMessages } = createMockPi();

    extension(pi as any);
    await vi.advanceTimersByTimeAsync(6100);
    await Promise.resolve();

    const ctx = makeCtx();
    for (const handler of extensionHandlers.get("turn_start") ?? []) {
      await handler(null, ctx);
    }
    for (const handler of extensionHandlers.get("before_agent_start") ?? []) {
      await handler(null, ctx);
    }

    const loopCreate = toolMap.get("LoopCreate");
    await loopCreate!.execute?.("1", {
      trigger: "*/5 * * * *",
      prompt: "Not yet due",
      triggerType: "cron",
      recurring: true,
    });

    expect(sentCustomMessages).toHaveLength(0);

    for (const handler of extensionHandlers.get("agent_start") ?? []) {
      await handler(null, ctx);
    }
    for (const handler of extensionHandlers.get("agent_end") ?? []) {
      await handler(null, ctx);
    }
    await Promise.resolve();

    expect(sentCustomMessages).toHaveLength(0);
  });

  it("pump fires again after time advances past next re-armed fire", async () => {
    const { pi, toolMap, extensionHandlers, sentCustomMessages } = createMockPi();

    extension(pi as any);
    await vi.advanceTimersByTimeAsync(6100);
    await Promise.resolve();

    const ctx = makeCtx();
    for (const handler of extensionHandlers.get("turn_start") ?? []) {
      await handler(null, ctx);
    }
    for (const handler of extensionHandlers.get("before_agent_start") ?? []) {
      await handler(null, ctx);
    }

    const loopCreate = toolMap.get("LoopCreate");
    await loopCreate!.execute?.("1", {
      trigger: "*/5 * * * *",
      prompt: "Recurring pump",
      triggerType: "cron",
      recurring: true,
    });

    vi.advanceTimersByTime(6 * 60 * 1000);

    for (const handler of extensionHandlers.get("agent_start") ?? []) {
      await handler(null, ctx);
    }
    for (const handler of extensionHandlers.get("agent_end") ?? []) {
      await handler(null, ctx);
    }
    await Promise.resolve();
    expect(sentCustomMessages).toHaveLength(1);

    vi.advanceTimersByTime(6 * 60 * 1000);

    for (const handler of extensionHandlers.get("agent_start") ?? []) {
      await handler(null, ctx);
    }
    for (const handler of extensionHandlers.get("agent_end") ?? []) {
      await handler(null, ctx);
    }
    await Promise.resolve();

    expect(sentCustomMessages.length).toBeGreaterThanOrEqual(2);
  });

  it("autoTask loop skips pump fire when no pending tasks", async () => {
    const { pi, toolMap, extensionHandlers, sentCustomMessages } = createMockPi();

    extension(pi as any);
    await vi.advanceTimersByTimeAsync(6100);
    await Promise.resolve();

    const ctx = makeCtx();
    for (const handler of extensionHandlers.get("turn_start") ?? []) {
      await handler(null, ctx);
    }
    for (const handler of extensionHandlers.get("before_agent_start") ?? []) {
      await handler(null, ctx);
    }

    const loopCreate = toolMap.get("LoopCreate");
    await loopCreate!.execute?.("1", {
      trigger: "*/5 * * * *",
      prompt: "Pump with autoTask — no tasks",
      triggerType: "cron",
      autoTask: true,
      recurring: true,
    });

    vi.advanceTimersByTime(6 * 60 * 1000);

    for (const handler of extensionHandlers.get("agent_start") ?? []) {
      await handler(null, ctx);
    }
    for (const handler of extensionHandlers.get("agent_end") ?? []) {
      await handler(null, ctx);
    }
    await Promise.resolve();

    expect(sentCustomMessages).toHaveLength(0);
  });
});
