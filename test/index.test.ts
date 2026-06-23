import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import extension from "../src/index.js";
import { createMockPi } from "./helpers/mock-pi.js";

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

  it("guides TaskCreate toward broad-goal decomposition without advertising unsupported fields", async () => {
    const { pi, toolMap } = createMockPi();

    extension(pi as any);
    await vi.advanceTimersByTimeAsync(6100);
    await Promise.resolve();

    const taskCreate = toolMap.get("TaskCreate") as any;
    expect(taskCreate.description).toContain("broad user goal");
    expect(taskCreate.description).not.toContain("metadata");
    expect(taskCreate.promptGuidelines).toContain(
      "When the user gives a broad goal, use multiple TaskCreate calls to decompose it into a small backlog of concrete tasks rather than one oversized task.",
    );
    expect(taskCreate.promptGuidelines).toContain(
      "If the user supplies a shared goal or meta-goal, preserve it explicitly using the user's wording and tie each created task back to that goal in its description.",
    );
    expect(taskCreate.promptGuidelines).toContain(
      "When the user asks to break work into tasks, create the backlog directly and do not pivot to loops, monitors, or other automation unless the user also asked for ongoing automation.",
    );
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

  it("ignores delayed native fallback registration after the extension context goes stale", async () => {
    const { pi } = createMockPi();
    const staleError = new Error("This extension ctx is stale after session replacement or reload.");

    extension(pi as any);
    pi.registerCommand = vi.fn(() => {
      throw staleError;
    });
    pi.registerTool = vi.fn(() => {
      throw staleError;
    });

    await vi.advanceTimersByTimeAsync(6100);

    expect(pi.registerCommand).toHaveBeenCalledTimes(1);
  });

  it("cancels delayed native fallback registration on session shutdown", async () => {
    const { pi, toolMap, commandMap, emitExtension } = createMockPi();

    extension(pi as any);
    await emitExtension("session_shutdown", null, {});
    await vi.advanceTimersByTimeAsync(6100);

    expect(toolMap.has("TaskCreate")).toBe(false);
    expect(commandMap.has("tasks")).toBe(false);
  });

  it("stores native tasks in a dedicated .pi/tasks/tasks.json path", async () => {
    const { pi, toolMap, extensionHandlers } = createMockPi();

    extension(pi as any);

    const ctx = {
      ui: { setStatus: vi.fn(), setWidget: vi.fn() },
      hasPendingMessages: () => false,
      sessionManager: { getSessionId: () => "test-session" },
    };
    for (const handler of extensionHandlers.get("turn_start") ?? []) {
      await handler(null, ctx);
    }

    await vi.advanceTimersByTimeAsync(6100);
    await Promise.resolve();

    const taskCreate = toolMap.get("TaskCreate");
    expect(taskCreate?.execute).toBeDefined();

    await taskCreate!.execute?.("1", { subject: "Test task", description: "Native fallback path" });

    const taskPath = join(cwd, ".pi", "tasks", "tasks-test-session.json");
    expect(existsSync(taskPath)).toBe(true);

    const data = JSON.parse(readFileSync(taskPath, "utf-8"));
    expect(data.tasks).toHaveLength(1);
    expect(data.tasks[0].subject).toBe("Test task");
  });

  it("creates scheduled loops through the /loop command against the current session store", async () => {
    const { pi, commandMap, extensionHandlers } = createMockPi();

    extension(pi as any);

    const ctx = {
      ui: { setStatus: vi.fn(), setWidget: vi.fn() },
      hasPendingMessages: () => false,
      sessionManager: { getSessionId: () => "test-session" },
    };
    for (const handler of extensionHandlers.get("turn_start") ?? []) {
      await handler(null, ctx);
    }

    const loopCommand = commandMap.get("loop");
    expect(loopCommand?.handler).toBeDefined();

    const ui = { notify: vi.fn(), select: vi.fn(), input: vi.fn() };
    await loopCommand!.handler?.("5m check deploy", { ui });

    const loopPath = join(cwd, ".pi", "loops", "loops-test-session.json");
    expect(existsSync(loopPath)).toBe(true);

    const data = JSON.parse(readFileSync(loopPath, "utf-8"));
    expect(data.loops).toHaveLength(1);
    expect(data.loops[0].prompt).toBe("check deploy");
    expect(data.loops[0].trigger).toEqual({ type: "cron", schedule: "*/5 * * * *" });
    expect(ui.notify).toHaveBeenCalledWith("Loop #1 created: every 5 minutes — check deploy", "info");
  });

  it("quick-creates native tasks through the /tasks command", async () => {
    const { pi, commandMap, extensionHandlers } = createMockPi();

    extension(pi as any);

    const ctx = {
      ui: { setStatus: vi.fn(), setWidget: vi.fn() },
      hasPendingMessages: () => false,
      sessionManager: { getSessionId: () => "test-session" },
    };
    for (const handler of extensionHandlers.get("turn_start") ?? []) {
      await handler(null, ctx);
    }

    await vi.advanceTimersByTimeAsync(6100);
    await Promise.resolve();

    const tasksCommand = commandMap.get("tasks");
    expect(tasksCommand?.handler).toBeDefined();

    const ui = { notify: vi.fn() };
    await tasksCommand!.handler?.("Write README updates", { ui });

    const taskPath = join(cwd, ".pi", "tasks", "tasks-test-session.json");
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

  it("updates native tasks through in_progress, completed, and reopened states", async () => {
    const { pi, toolMap, extensionHandlers } = createMockPi();

    extension(pi as any);

    const ctx = {
      ui: { setStatus: vi.fn(), setWidget: vi.fn() },
      hasPendingMessages: () => false,
      sessionManager: { getSessionId: () => "test-session" },
    };
    for (const handler of extensionHandlers.get("turn_start") ?? []) {
      await handler(null, ctx);
    }

    await vi.advanceTimersByTimeAsync(6100);
    await Promise.resolve();

    const taskCreate = toolMap.get("TaskCreate");
    const taskUpdate = toolMap.get("TaskUpdate");
    const taskList = toolMap.get("TaskList");
    expect(taskCreate?.execute).toBeDefined();
    expect(taskUpdate?.execute).toBeDefined();
    expect(taskList?.execute).toBeDefined();

    await taskCreate!.execute?.("1", { subject: "Transition task", description: "track transitions" });

    let result = await taskUpdate!.execute?.("2", { id: "1", status: "in_progress" });
    expect(result.content[0].text).toBe("Task #1 updated → in_progress");

    let listResult = await taskList!.execute?.("3", {});
    expect(listResult.content[0].text).toContain("#1 [in_progress] Transition task");

    result = await taskUpdate!.execute?.("4", { id: "1", status: "completed" });
    expect(result.content[0].text).toBe("Task #1 updated → completed");

    const taskPath = join(cwd, ".pi", "tasks", "tasks-test-session.json");
    let data = JSON.parse(readFileSync(taskPath, "utf-8"));
    expect(data.tasks[0].status).toBe("completed");
    expect(typeof data.tasks[0].completedAt).toBe("number");
    const completedAt = data.tasks[0].completedAt;

    result = await taskUpdate!.execute?.("5", { id: "1", status: "pending" });
    expect(result.content[0].text).toBe("Task #1 updated → pending");

    listResult = await taskList!.execute?.("6", {});
    expect(listResult.content[0].text).toContain("#1 [pending] Transition task");

    data = JSON.parse(readFileSync(taskPath, "utf-8"));
    expect(data.tasks[0].status).toBe("pending");
    expect(data.tasks[0].completedAt).toBe(completedAt);
  });

  it("auto-creates a worker loop when pending native tasks reach five", async () => {
    const { pi, toolMap, extensionHandlers } = createMockPi();

    extension(pi as any);

    const ctx = {
      ui: { setStatus: vi.fn(), setWidget: vi.fn() },
      hasPendingMessages: () => false,
      sessionManager: { getSessionId: () => "test-session" },
    };
    for (const handler of extensionHandlers.get("turn_start") ?? []) {
      await handler(null, ctx);
    }

    await vi.advanceTimersByTimeAsync(6100);
    await Promise.resolve();

    const taskCreate = toolMap.get("TaskCreate");
    const loopList = toolMap.get("LoopList");
    expect(taskCreate?.execute).toBeDefined();
    expect(loopList?.execute).toBeDefined();

    for (let i = 1; i <= 4; i++) {
      const result = await taskCreate!.execute?.(`${i}`, {
        subject: `Task ${i}`,
        description: `Desc ${i}`,
      });
      expect(result.content[0].text).not.toContain("Backlog worker loop #");
    }

    let listResult = await loopList!.execute?.("10", {});
    expect(listResult.content[0].text).toBe("No loops configured. Use LoopCreate to set up a schedule.");

    const fifth = await taskCreate!.execute?.("11", {
      subject: "Task 5",
      description: "Desc 5",
    });
    expect(fifth.content[0].text).toContain("Backlog worker loop #1 created");

    listResult = await loopList!.execute?.("12", {});
    expect(listResult.content[0].text).toContain("hybrid:");
    expect(listResult.content[0].text).toContain("tasks:created");
  });

  it("does not create duplicate worker loops above the task threshold", async () => {
    const { pi, toolMap, extensionHandlers } = createMockPi();

    extension(pi as any);

    const ctx = {
      ui: { setStatus: vi.fn(), setWidget: vi.fn() },
      hasPendingMessages: () => false,
      sessionManager: { getSessionId: () => "test-session" },
    };
    for (const handler of extensionHandlers.get("turn_start") ?? []) {
      await handler(null, ctx);
    }

    await vi.advanceTimersByTimeAsync(6100);
    await Promise.resolve();

    const taskCreate = toolMap.get("TaskCreate");
    const loopList = toolMap.get("LoopList");

    for (let i = 1; i <= 5; i++) {
      await taskCreate!.execute?.(`${i}`, {
        subject: `Task ${i}`,
        description: `Desc ${i}`,
      });
    }

    const sixth = await taskCreate!.execute?.("6", {
      subject: "Task 6",
      description: "Desc 6",
    });
    expect(sixth.content[0].text).not.toContain("auto-created");

    const listResult = await loopList!.execute?.("7", {});
    const lines = listResult.content[0].text.split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("#1");
  });

  it("re-creates a worker loop when TaskUpdate raises pending work back to the threshold", async () => {
    const { pi, toolMap, extensionHandlers } = createMockPi();

    extension(pi as any);

    const ctx = {
      ui: { setStatus: vi.fn(), setWidget: vi.fn() },
      hasPendingMessages: () => false,
      sessionManager: { getSessionId: () => "test-session" },
    };
    for (const handler of extensionHandlers.get("turn_start") ?? []) {
      await handler(null, ctx);
    }

    await vi.advanceTimersByTimeAsync(6100);
    await Promise.resolve();

    const taskCreate = toolMap.get("TaskCreate");
    const taskUpdate = toolMap.get("TaskUpdate");
    const loopList = toolMap.get("LoopList");
    expect(taskCreate?.execute).toBeDefined();
    expect(taskUpdate?.execute).toBeDefined();
    expect(loopList?.execute).toBeDefined();

    for (let i = 1; i <= 5; i++) {
      await taskCreate!.execute?.(`${i}`, {
        subject: `Task ${i}`,
        description: `Desc ${i}`,
      });
    }
    for (let i = 1; i <= 5; i++) {
      await taskUpdate!.execute?.(`${10 + i}`, { id: `${i}`, status: "completed" });
    }

    let listResult = await loopList!.execute?.("30", {});
    expect(listResult.content[0].text).toBe("No loops configured. Use LoopCreate to set up a schedule.");

    for (let i = 1; i <= 4; i++) {
      const result = await taskUpdate!.execute?.(`${20 + i}`, { id: `${i}`, status: "pending" });
      expect(result.content[0].text).toBe(`Task #${i} updated → pending`);
    }

    listResult = await loopList!.execute?.("40", {});
    expect(listResult.content[0].text).toBe("No loops configured. Use LoopCreate to set up a schedule.");

    const thresholdResult = await taskUpdate!.execute?.("50", { id: "5", status: "pending" });
    expect(thresholdResult.content[0].text).toContain("Backlog worker loop #");

    listResult = await loopList!.execute?.("60", {});
    expect(listResult.content[0].text).toContain("tasks:created");
    expect(listResult.content[0].text).toContain("Run TaskList, pick next pending task");
  });

  it("flushes the auto-created worker wake on agent_end even if pending messages are reported", async () => {
    const { pi, toolMap, extensionHandlers, sentMessages: sentCustomMessages } = createMockPi();

    extension(pi as any);

    let hasPendingMessages = false;
    const ctx = {
      ui: { setStatus: vi.fn(), setWidget: vi.fn() },
      hasPendingMessages: () => hasPendingMessages,
      sessionManager: { getSessionId: () => "test-session" },
    };
    for (const handler of extensionHandlers.get("turn_start") ?? []) {
      await handler(null, ctx);
    }

    await vi.advanceTimersByTimeAsync(6100);
    await Promise.resolve();

    const taskCreate = toolMap.get("TaskCreate");
    expect(taskCreate?.execute).toBeDefined();

    for (const handler of extensionHandlers.get("agent_start") ?? []) {
      await handler(null, ctx);
    }

    for (let i = 1; i <= 5; i++) {
      await taskCreate!.execute?.(`${i}`, {
        subject: `Task ${i}`,
        description: `Desc ${i}`,
      });
    }

    expect(sentCustomMessages).toHaveLength(0);

    hasPendingMessages = true;
    for (const handler of extensionHandlers.get("agent_end") ?? []) {
      await handler(null, ctx);
    }
    await Promise.resolve();

    expect(sentCustomMessages).toHaveLength(1);
    expect(sentCustomMessages[0].options).toEqual({ deliverAs: "steer", triggerTurn: true });
    expect((sentCustomMessages[0].message as { content: string }).content).toContain("Run TaskList, pick next pending task");
  });

  it("auto-deletes the worker loop after all native tasks are completed", async () => {
    const { pi, toolMap, extensionHandlers } = createMockPi();

    extension(pi as any);

    const ctx = {
      ui: { setStatus: vi.fn(), setWidget: vi.fn() },
      hasPendingMessages: () => false,
      sessionManager: { getSessionId: () => "test-session" },
    };
    for (const handler of extensionHandlers.get("turn_start") ?? []) {
      await handler(null, ctx);
    }

    await vi.advanceTimersByTimeAsync(6100);
    await Promise.resolve();

    const taskCreate = toolMap.get("TaskCreate");
    const taskUpdate = toolMap.get("TaskUpdate");
    const loopList = toolMap.get("LoopList");
    expect(taskCreate?.execute).toBeDefined();
    expect(taskUpdate?.execute).toBeDefined();
    expect(loopList?.execute).toBeDefined();

    for (let i = 1; i <= 5; i++) {
      await taskCreate!.execute?.(`${i}`, {
        subject: `Task ${i}`,
        description: `Desc ${i}`,
      });
    }

    let listResult = await loopList!.execute?.("20", {});
    expect(listResult.content[0].text).toContain("#1");

    for (let i = 1; i <= 5; i++) {
      await taskUpdate!.execute?.(`${20 + i}`, { id: `${i}`, status: "completed" });
    }

    for (const handler of extensionHandlers.get("agent_end") ?? []) {
      await handler(null, ctx);
    }
    await Promise.resolve();

    listResult = await loopList!.execute?.("30", {});
    expect(listResult.content[0].text).toBe("No loops configured. Use LoopCreate to set up a schedule.");
  });

  it("prunes completed native tasks after a successful git commit and preserves monotonic ids", async () => {
    const { pi, toolMap, extensionHandlers } = createMockPi();

    extension(pi as any);

    const ctx = {
      ui: { setStatus: vi.fn(), setWidget: vi.fn() },
      hasPendingMessages: () => false,
      sessionManager: { getSessionId: () => "test-session" },
    };
    for (const handler of extensionHandlers.get("turn_start") ?? []) {
      await handler(null, ctx);
    }

    await vi.advanceTimersByTimeAsync(6100);
    await Promise.resolve();

    const taskCreate = toolMap.get("TaskCreate");
    const taskUpdate = toolMap.get("TaskUpdate");
    const taskList = toolMap.get("TaskList");
    expect(taskCreate?.execute).toBeDefined();
    expect(taskUpdate?.execute).toBeDefined();
    expect(taskList?.execute).toBeDefined();

    await taskCreate!.execute?.("1", { subject: "Done 1", description: "d1" });
    await taskCreate!.execute?.("2", { subject: "Done 2", description: "d2" });
    await taskCreate!.execute?.("3", { subject: "Active 3", description: "d3" });

    await taskUpdate!.execute?.("4", { id: "1", status: "completed" });
    await taskUpdate!.execute?.("5", { id: "2", status: "completed" });
    await taskUpdate!.execute?.("6", { id: "3", status: "in_progress" });

    for (const handler of extensionHandlers.get("tool_execution_end") ?? []) {
      await handler({
        toolCallId: "bash-1",
        toolName: "bash",
        args: { command: "git commit -m 'checkpoint'" },
        isError: false,
        result: { stdout: "[master abc123] checkpoint" },
      }, ctx);
    }
    await Promise.resolve();

    let listResult = await taskList!.execute?.("7", {});
    expect(listResult.content[0].text).toContain("1 tasks (0 pending, 1 in progress, 0 done)");
    expect(listResult.content[0].text).toContain("#3 [in_progress] Active 3");
    expect(listResult.content[0].text).not.toContain("#1 [completed]");
    expect(listResult.content[0].text).not.toContain("#2 [completed]");

    const createResult = await taskCreate!.execute?.("8", { subject: "New 4", description: "d4" });
    expect(createResult.content[0].text).toContain("Task #4 created: New 4");

    listResult = await taskList!.execute?.("9", {});
    expect(listResult.content[0].text).toContain("#4 [pending] New 4");
  });

  it("does not prune completed native tasks after failed or non-commit bash tools", async () => {
    const { pi, toolMap, extensionHandlers } = createMockPi();

    extension(pi as any);

    const ctx = {
      ui: { setStatus: vi.fn(), setWidget: vi.fn() },
      hasPendingMessages: () => false,
      sessionManager: { getSessionId: () => "test-session" },
    };
    for (const handler of extensionHandlers.get("turn_start") ?? []) {
      await handler(null, ctx);
    }

    await vi.advanceTimersByTimeAsync(6100);
    await Promise.resolve();

    const taskCreate = toolMap.get("TaskCreate");
    const taskUpdate = toolMap.get("TaskUpdate");
    const taskList = toolMap.get("TaskList");

    await taskCreate!.execute?.("1", { subject: "Done 1", description: "d1" });
    await taskUpdate!.execute?.("2", { id: "1", status: "completed" });

    for (const handler of extensionHandlers.get("tool_execution_end") ?? []) {
      await handler({
        toolCallId: "bash-1",
        toolName: "bash",
        args: { command: "git status" },
        isError: false,
        result: { stdout: "On branch master" },
      }, ctx);
      await handler({
        toolCallId: "bash-2",
        toolName: "bash",
        args: { command: "git commit -m 'broken'" },
        isError: true,
        result: { stderr: "nothing to commit" },
      }, ctx);
    }
    await Promise.resolve();

    const listResult = await taskList!.execute?.("3", {});
    expect(listResult.content[0].text).toContain("1 tasks (0 pending, 0 in progress, 1 done)");
    expect(listResult.content[0].text).toContain("#1 [completed] Done 1");
  });

  it("manual task-backlog loops auto-delete after the pending queue clears", async () => {
    const { pi, toolMap, extensionHandlers } = createMockPi();

    extension(pi as any);

    const ctx = {
      ui: { setStatus: vi.fn(), setWidget: vi.fn() },
      hasPendingMessages: () => false,
      sessionManager: { getSessionId: () => "test-session" },
    };
    for (const handler of extensionHandlers.get("turn_start") ?? []) {
      await handler(null, ctx);
    }

    await vi.advanceTimersByTimeAsync(6100);
    await Promise.resolve();

    const taskCreate = toolMap.get("TaskCreate");
    const taskUpdate = toolMap.get("TaskUpdate");
    const loopCreate = toolMap.get("LoopCreate");
    const loopList = toolMap.get("LoopList");
    expect(taskCreate?.execute).toBeDefined();
    expect(taskUpdate?.execute).toBeDefined();
    expect(loopCreate?.execute).toBeDefined();
    expect(loopList?.execute).toBeDefined();

    await taskCreate!.execute?.("1", { subject: "Existing task", description: "Created before loop" });

    const result = await loopCreate!.execute?.("2", {
      trigger: "tasks:created",
      prompt: "Pick the next pending task and work on it",
      triggerType: "event",
      recurring: true,
      taskBacklog: true,
    });

    expect(result.content[0].text).toContain("Backlog worker: enabled");
    expect(result.content[0].text).toContain("Backlog: initial wake queued for existing pending tasks");

    let listResult = await loopList!.execute?.("3", {});
    expect(listResult.content[0].text).toContain("#1");

    await taskUpdate!.execute?.("4", { id: "1", status: "completed" });

    listResult = await loopList!.execute?.("5", {});
    expect(listResult.content[0].text).toBe("No loops configured. Use LoopCreate to set up a schedule.");
  });

  it("plain tasks:created watcher loops stay active after the pending queue clears", async () => {
    const { pi, toolMap, extensionHandlers } = createMockPi();

    extension(pi as any);

    const ctx = {
      ui: { setStatus: vi.fn(), setWidget: vi.fn() },
      hasPendingMessages: () => false,
      sessionManager: { getSessionId: () => "test-session" },
    };
    for (const handler of extensionHandlers.get("turn_start") ?? []) {
      await handler(null, ctx);
    }

    await vi.advanceTimersByTimeAsync(6100);
    await Promise.resolve();

    const taskCreate = toolMap.get("TaskCreate");
    const taskUpdate = toolMap.get("TaskUpdate");
    const loopCreate = toolMap.get("LoopCreate");
    const loopList = toolMap.get("LoopList");
    expect(taskCreate?.execute).toBeDefined();
    expect(taskUpdate?.execute).toBeDefined();
    expect(loopCreate?.execute).toBeDefined();
    expect(loopList?.execute).toBeDefined();

    await taskCreate!.execute?.("1", { subject: "Existing task", description: "Created before loop" });

    await loopCreate!.execute?.("2", {
      trigger: "tasks:created",
      prompt: "Start work on the new task",
      triggerType: "event",
      recurring: true,
    });

    await taskUpdate!.execute?.("3", { id: "1", status: "completed" });

    const listResult = await loopList!.execute?.("4", {});
    expect(listResult.content[0].text).toContain("#1");
    expect(listResult.content[0].text).toContain("tasks:created");
  });

  it("wakes immediately when a recurring tasks:created loop is bootstrapped against existing pending tasks", async () => {
    const { pi, toolMap, sentMessages: sentCustomMessages } = createMockPi();

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

    expect(result.content[0].text).toContain("Backlog: initial wake queued for existing pending tasks");
    expect(sentCustomMessages).toHaveLength(1);
    expect(sentCustomMessages[0].options).toEqual({ deliverAs: "steer", triggerTurn: true });
    expect((sentCustomMessages[0].message as { content: string }).content).toContain("Pick the next pending task and work on it");
  });

  it("wakes when a future native task creation matches a recurring tasks:created loop", async () => {
    const { pi, toolMap, sentMessages: sentCustomMessages } = createMockPi();

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
    const { pi, toolMap, extensionHandlers } = createMockPi();

    extension(pi as any);

    const ctx = {
      ui: { setStatus: vi.fn(), setWidget: vi.fn() },
      hasPendingMessages: () => false,
      sessionManager: { getSessionId: () => "test-session" },
    };
    for (const handler of extensionHandlers.get("turn_start") ?? []) {
      await handler(null, ctx);
    }

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

    const taskPath = join(cwd, ".pi", "tasks", "tasks-test-session.json");
    const data = JSON.parse(readFileSync(taskPath, "utf-8"));
    expect(data.tasks).toHaveLength(1);
    expect(data.tasks[0].subject).toBe("Follow up on native task work");
    expect(data.tasks[0].description).toContain("Auto-created from loop #");
    expect(data.tasks[0].metadata.loopId).toBe("1");
  });

  it("sweeps completed native tasks and skips follow-up wake when no tasks remain", async () => {
    const { pi, toolMap, sentUserMessages: sentMessages, extensionHandlers } = createMockPi();

    extension(pi as any);

    const ctx = {
      ui: { setStatus: vi.fn(), setWidget: vi.fn() },
      hasPendingMessages: () => false,
      sessionManager: { getSessionId: () => "test-session" },
    };
    for (const handler of extensionHandlers.get("turn_start") ?? []) {
      await handler(null, ctx);
    }

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

    const taskPath = join(cwd, ".pi", "tasks", "tasks-test-session.json");
    const data = JSON.parse(readFileSync(taskPath, "utf-8"));
    expect(data.tasks).toHaveLength(0);
    expect(sentMessages).toHaveLength(0);
  });

  it("drops a buffered native autoTask wake when tasks finish before agent_end", async () => {
    const {
      pi,
      toolMap,
      extensionHandlers,
      sentMessages: sentCustomMessages,
      sentUserMessages: sentMessages,
    } = createMockPi();

    extension(pi as any);

    const ctx = {
      ui: { setStatus: vi.fn(), setWidget: vi.fn() },
      hasPendingMessages: () => false,
      sessionManager: { getSessionId: () => "test-session" },
    };
    for (const handler of extensionHandlers.get("turn_start") ?? []) {
      await handler(null, ctx);
    }

    await vi.advanceTimersByTimeAsync(6100);
    await Promise.resolve();

    const taskCreate = toolMap.get("TaskCreate");
    const taskUpdate = toolMap.get("TaskUpdate");
    expect(taskCreate?.execute).toBeDefined();
    expect(taskUpdate?.execute).toBeDefined();

    await taskCreate!.execute?.("1", { subject: "Buffered task", description: "will complete before flush" });

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

    const taskPath = join(cwd, ".pi", "tasks", "tasks-test-session.json");
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

  it("fires a due cron loop once via the heartbeat, without double-firing on a later agent_end pump", async () => {
    const { pi, toolMap, extensionHandlers, sentMessages: sentCustomMessages } = createMockPi();

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

    // maxFires:1 makes "fires exactly once" structural (the scheduler deletes
    // the loop after its single fire), so the no-double-fire assertion below is
    // deterministic rather than dependent on recurring re-arm timing.
    await loopCreate!.execute?.("1", {
      trigger: "*/5 * * * *",
      prompt: "Dynamic idle fire",
      triggerType: "cron",
      recurring: true,
      maxFires: 1,
    });

    // The heartbeat pumps while idle, so the loop fires once its time passes —
    // no turn boundary required.
    await vi.advanceTimersByTimeAsync(11 * 60 * 1000);
    expect(sentCustomMessages).toHaveLength(1);
    expect(sentCustomMessages[0].options).toEqual({ deliverAs: "steer", triggerTurn: true });
    expect((sentCustomMessages[0].message as { content: string }).content).toContain("Dynamic idle fire");

    // The loop reached its fire cap and was deleted; a later turn boundary
    // (and further heartbeat ticks) must not deliver a second wake.
    for (const handler of extensionHandlers.get("agent_start") ?? []) {
      await handler(null, ctx);
    }
    for (const handler of extensionHandlers.get("agent_end") ?? []) {
      await handler(null, ctx);
    }
    await vi.advanceTimersByTimeAsync(6 * 60 * 1000);

    expect(sentCustomMessages).toHaveLength(1);
  });

  it("fires idle cron loops via the heartbeat without any turn boundary", async () => {
    const { pi, toolMap, extensionHandlers, sentMessages: sentCustomMessages } = createMockPi();

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
      prompt: "Idle heartbeat fire",
      triggerType: "cron",
      recurring: true,
    });
    expect(sentCustomMessages).toHaveLength(0);

    // Agent is idle (no agent_start/agent_end, no further turns). Advancing
    // wall-clock time alone must re-wake the agent via the heartbeat pump.
    await vi.advanceTimersByTimeAsync(11 * 60 * 1000);

    expect(sentCustomMessages).toHaveLength(1);
    expect(sentCustomMessages[0].options).toEqual({ deliverAs: "steer", triggerTurn: true });
    expect((sentCustomMessages[0].message as { content: string }).content).toContain("Idle heartbeat fire");
  });

  it("pump does not fire when next fire time has not been reached", async () => {
    const { pi, toolMap, extensionHandlers, sentMessages: sentCustomMessages } = createMockPi();

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
    const { pi, toolMap, extensionHandlers, sentMessages: sentCustomMessages } = createMockPi();

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
    const { pi, toolMap, extensionHandlers, sentMessages: sentCustomMessages } = createMockPi();

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

describe("LoopDelete tool wrapper", () => {
  let cwd: string;
  let originalCwd: string;

  beforeEach(() => {
    vi.useFakeTimers();
    originalCwd = process.cwd();
    cwd = mkdtempSync(join(tmpdir(), "pi-loop-delete-"));
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

  it("deletes an existing loop", async () => {
    const { pi, toolMap, extensionHandlers } = createMockPi();

    extension(pi as any);
    await vi.advanceTimersByTimeAsync(6100);
    await Promise.resolve();

    const ctx = makeCtx();
    for (const handler of extensionHandlers.get("turn_start") ?? []) {
      await handler(null, ctx);
    }

    const loopCreate = toolMap.get("LoopCreate");
    const loopDelete = toolMap.get("LoopDelete");
    expect(loopCreate?.execute).toBeDefined();
    expect(loopDelete?.execute).toBeDefined();

    await loopCreate!.execute?.("1", {
      trigger: "tool_execution_start",
      prompt: "Delete me",
      triggerType: "event",
      recurring: true,
    });

    const result = await loopDelete!.execute?.("2", { id: "1" });
    expect(result.content[0].text).toBe("Loop #1 deleted");

    const loopList = toolMap.get("LoopList");
    const listResult = await loopList!.execute?.("3", {});
    expect(listResult.content[0].text).toBe("No loops configured. Use LoopCreate to set up a schedule.");
  });

  it("pauses an existing loop", async () => {
    const { pi, toolMap, extensionHandlers } = createMockPi();

    extension(pi as any);
    await vi.advanceTimersByTimeAsync(6100);
    await Promise.resolve();

    const ctx = makeCtx();
    for (const handler of extensionHandlers.get("turn_start") ?? []) {
      await handler(null, ctx);
    }

    const loopCreate = toolMap.get("LoopCreate");
    const loopDelete = toolMap.get("LoopDelete");
    await loopCreate!.execute?.("1", {
      trigger: "tool_execution_start",
      prompt: "Pause me",
      triggerType: "event",
      recurring: true,
    });

    const result = await loopDelete!.execute?.("2", { id: "1", action: "pause" });
    expect(result.content[0].text).toBe("Loop #1 paused");

    const loopList = toolMap.get("LoopList");
    const listResult = await loopList!.execute?.("3", {});
    expect(listResult.content[0].text).toContain("[paused]");
  });

  it("returns not found for non-existent loop", async () => {
    const { pi, toolMap, extensionHandlers } = createMockPi();

    extension(pi as any);
    await vi.advanceTimersByTimeAsync(6100);
    await Promise.resolve();

    const ctx = makeCtx();
    for (const handler of extensionHandlers.get("turn_start") ?? []) {
      await handler(null, ctx);
    }

    const loopDelete = toolMap.get("LoopDelete");
    expect(loopDelete?.execute).toBeDefined();

    const deleteResult = await loopDelete!.execute?.("1", { id: "999" });
    expect(deleteResult.content[0].text).toBe("Loop #999 not found");

    const pauseResult = await loopDelete!.execute?.("2", { id: "999", action: "pause" });
    expect(pauseResult.content[0].text).toBe("Loop #999 not found");
  });

  it("defaults to delete when no action specified", async () => {
    const { pi, toolMap, extensionHandlers } = createMockPi();

    extension(pi as any);
    await vi.advanceTimersByTimeAsync(6100);
    await Promise.resolve();

    const ctx = makeCtx();
    for (const handler of extensionHandlers.get("turn_start") ?? []) {
      await handler(null, ctx);
    }

    const loopCreate = toolMap.get("LoopCreate");
    const loopDelete = toolMap.get("LoopDelete");
    await loopCreate!.execute?.("1", {
      trigger: "tool_execution_start",
      prompt: "Default delete",
      triggerType: "event",
      recurring: true,
    });

    const result = await loopDelete!.execute?.("2", { id: "1" });
    expect(result.content[0].text).toBe("Loop #1 deleted");
  });
});

describe("monitor tool wrappers", () => {
  let cwd: string;
  let originalCwd: string;
  let originalScope: string | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    originalCwd = process.cwd();
    originalScope = process.env.PI_LOOP_SCOPE;
    cwd = mkdtempSync(join(tmpdir(), "pi-loop-mon-"));
    process.chdir(cwd);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalScope === undefined) delete process.env.PI_LOOP_SCOPE;
    else process.env.PI_LOOP_SCOPE = originalScope;
    rmSync(cwd, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it("MonitorCreate starts a monitor and returns expected output", async () => {
    const { pi, toolMap } = createMockPi();

    extension(pi as any);
    await vi.advanceTimersByTimeAsync(6100);
    await Promise.resolve();

    const monitorCreate = toolMap.get("MonitorCreate");
    expect(monitorCreate?.execute).toBeDefined();

    const result = await monitorCreate!.execute?.("1", {
      command: "echo hello",
      description: "test monitor",
    });
    expect(result.content[0].text).toContain("Monitor #1 started");
    expect(result.content[0].text).toContain("echo hello");
  });

  it("MonitorCreate with onDone creates a completion loop", async () => {
    const { pi, toolMap } = createMockPi();

    extension(pi as any);
    await vi.advanceTimersByTimeAsync(6100);
    await Promise.resolve();

    const monitorCreate = toolMap.get("MonitorCreate");

    const result = await monitorCreate!.execute?.("1", {
      command: "echo done",
      onDone: "Report completion",
    });
    expect(result.content[0].text).toContain("Monitor #1 started");
    expect(result.content[0].text).toContain("Completion wake loop");
    expect(result.content[0].text).toContain("fires when the monitor completes");
  });

  it("MonitorList returns empty-state message when no monitors", async () => {
    const { pi, toolMap } = createMockPi();

    extension(pi as any);
    await vi.advanceTimersByTimeAsync(6100);
    await Promise.resolve();

    const monitorList = toolMap.get("MonitorList");
    expect(monitorList?.execute).toBeDefined();

    const result = await monitorList!.execute?.("1", {});
    expect(result.content[0].text).toBe("No monitors.");
  });

  it("MonitorList shows monitors with status and output lines", async () => {
    const { pi, toolMap } = createMockPi();

    extension(pi as any);
    await vi.advanceTimersByTimeAsync(6100);
    await Promise.resolve();

    const monitorCreate = toolMap.get("MonitorCreate");
    const monitorList = toolMap.get("MonitorList");

    await monitorCreate!.execute?.("1", { command: "echo test-mon", description: "list test" });
    await vi.advanceTimersByTimeAsync(500);

    const result = await monitorList!.execute?.("2", {});
    expect(result.content[0].text).toContain("test-mon");
    expect(result.content[0].text).toContain("lines");
  });

  it("MonitorStop stops a running monitor", async () => {
    const { pi, toolMap } = createMockPi();

    extension(pi as any);
    await vi.advanceTimersByTimeAsync(6100);
    await Promise.resolve();

    const monitorCreate = toolMap.get("MonitorCreate");
    const monitorStop = toolMap.get("MonitorStop");

    // Switch to real timers so the 5-second SIGKILL grace period in
    // MonitorManager.stop() can resolve. Fake timers would block the
    // child-process 'close' event and leave the stop promise hanging.
    vi.useRealTimers();
    await monitorCreate!.execute?.("1", { command: "sleep 1", timeout: 0 });

    const result = await monitorStop!.execute?.("2", { monitorId: "1" });
    expect(result.content[0].text).toBe("Monitor #1 stopped");
  });

  it("MonitorStop returns not-found for non-existent monitor", async () => {
    const { pi, toolMap } = createMockPi();

    extension(pi as any);
    await vi.advanceTimersByTimeAsync(6100);
    await Promise.resolve();

    const monitorStop = toolMap.get("MonitorStop");
    expect(monitorStop?.execute).toBeDefined();

    const result = await monitorStop!.execute?.("1", { monitorId: "999" });
    expect(result.content[0].text).toContain("not found");
  });

  it("onDone monitor completion delivers a custom message wake", async () => {
    vi.useRealTimers();
    const { pi, toolMap, sentMessages: sentCustomMessages } = createMockPi();

    extension(pi as any);
    await new Promise(r => setTimeout(r, 6100));

    const monitorCreate = toolMap.get("MonitorCreate");
    expect(monitorCreate?.execute).toBeDefined();

    const result = await monitorCreate!.execute?.("1", {
      command: "echo 'monitor done'",
      onDone: "Monitor finished — report results",
    });
    expect(result.content[0].text).toContain("Completion wake loop");

    await new Promise(r => setTimeout(r, 500));

    expect(sentCustomMessages).toHaveLength(1);
    expect((sentCustomMessages[0].message as { content: string }).content).toContain("Monitor finished");
  }, 10000);

  it("onDone monitor completion does not rely on monitor:done event dispatch", async () => {
    vi.useRealTimers();
    const { pi, toolMap, sentMessages: sentCustomMessages } = createMockPi({ suppressMonitorDoneDispatch: true });

    extension(pi as any);
    await new Promise(r => setTimeout(r, 6100));

    const monitorCreate = toolMap.get("MonitorCreate");
    expect(monitorCreate?.execute).toBeDefined();

    const result = await monitorCreate!.execute?.("1", {
      command: "echo 'monitor done'",
      onDone: "Monitor finished without event dispatch",
    });
    expect(result.content[0].text).toContain("Completion wake loop");

    await new Promise(r => setTimeout(r, 500));

    expect(sentCustomMessages).toHaveLength(1);
    expect((sentCustomMessages[0].message as { content: string }).content).toContain("Monitor finished without event dispatch");
  }, 10000);

  it("buffers onDone monitor completion until agent_end when the agent is busy", async () => {
    vi.useRealTimers();
    const { pi, toolMap, extensionHandlers, sentMessages: sentCustomMessages } = createMockPi();

    extension(pi as any);
    await new Promise(r => setTimeout(r, 6100));

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

    const monitorCreate = toolMap.get("MonitorCreate");
    expect(monitorCreate?.execute).toBeDefined();

    const result = await monitorCreate!.execute?.("1", {
      command: "echo 'monitor done while busy'",
      onDone: "Monitor finished while agent busy",
    });
    expect(result.content[0].text).toContain("Completion wake loop");

    await new Promise(r => setTimeout(r, 500));
    expect(sentCustomMessages).toHaveLength(0);

    for (const handler of extensionHandlers.get("agent_end") ?? []) {
      await handler(null, ctx);
    }
    await new Promise(r => setTimeout(r, 50));

    expect(sentCustomMessages).toHaveLength(1);
    expect((sentCustomMessages[0].message as { content: string }).content).toContain("Monitor finished while agent busy");
  }, 10000);

  it("delivers monitor completion wake immediately in an idle session after agent_end", async () => {
    vi.useRealTimers();
    const { pi, toolMap, extensionHandlers, sentMessages: sentCustomMessages } = createMockPi();

    extension(pi as any);
    await new Promise(r => setTimeout(r, 6100));

    // Simulate session start, running, and then going idle (agent_end)
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
    for (const handler of extensionHandlers.get("agent_end") ?? []) {
      await handler(null, ctx);
    }

    // Start a monitor with onDone
    const monitorCreate = toolMap.get("MonitorCreate");
    const result = await monitorCreate!.execute?.("1", {
      command: "echo 'monitor idle wake'",
      onDone: "Monitor completed during idle session",
    });
    expect(result.content[0].text).toContain("Completion wake loop");

    // Wait for process to exit and wake to deliver
    await new Promise(r => setTimeout(r, 500));

    // It should deliver the wake immediately because the session is idle!
    expect(sentCustomMessages).toHaveLength(1);
    expect((sentCustomMessages[0].message as { content: string }).content).toContain("Monitor completed during idle session");
  }, 10000);

  it("delivers monitor completion wake even when the command exits with non-zero status in an idle session", async () => {
    vi.useRealTimers();
    const { pi, toolMap, extensionHandlers, sentMessages: sentCustomMessages } = createMockPi();

    extension(pi as any);
    await new Promise(r => setTimeout(r, 6100));

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
    for (const handler of extensionHandlers.get("agent_end") ?? []) {
      await handler(null, ctx);
    }

    const monitorCreate = toolMap.get("MonitorCreate");
    const result = await monitorCreate!.execute?.("1", {
      command: "exit 3", // fails
      onDone: "Monitor failed in idle session",
    });
    expect(result.content[0].text).toContain("Completion wake loop");

    await new Promise(r => setTimeout(r, 500));

    // Wake should still be delivered to notify about the failure!
    expect(sentCustomMessages).toHaveLength(1);
    expect((sentCustomMessages[0].message as { content: string }).content).toContain("Monitor failed in idle session");
  }, 10000);

  it("does not deliver monitor completion wake if the completion loop is deleted", async () => {
    vi.useRealTimers();
    const { pi, toolMap, extensionHandlers, sentMessages: sentCustomMessages } = createMockPi();

    extension(pi as any);
    await new Promise(r => setTimeout(r, 6100));

    const ctx = {
      ui: { setStatus: vi.fn(), setWidget: vi.fn() },
      hasPendingMessages: () => false,
      sessionManager: { getSessionId: () => "test-session" },
    };
    for (const handler of extensionHandlers.get("turn_start") ?? []) {
      await handler(null, ctx);
    }
    for (const handler of extensionHandlers.get("agent_end") ?? []) {
      await handler(null, ctx);
    }

    const monitorCreate = toolMap.get("MonitorCreate");
    const loopDelete = toolMap.get("LoopDelete");

    const result = await monitorCreate!.execute?.("1", {
      command: "sleep 10 && echo done",
      onDone: "Never delivered",
    });
    expect(result.content[0].text).toContain("Completion wake loop #1");

    // Delete the one-shot completion loop before it fires
    await loopDelete!.execute?.("2", { id: "1", action: "delete" });

    await new Promise(r => setTimeout(r, 200));
    expect(sentCustomMessages).toHaveLength(0);
  }, 10000);

  it("monitor create list stop lifecycle reflects state changes", async () => {
    const { pi, toolMap } = createMockPi();

    extension(pi as any);
    // Advance the native task fallback timer with fake timers so the 6.1s real
    // wait is instant, then switch to real timers for the stop path (the 5s
    // SIGKILL grace period in MonitorManager.stop() needs real I/O).
    await vi.advanceTimersByTimeAsync(6100);
    await Promise.resolve();
    vi.useRealTimers();

    const monitorCreate = toolMap.get("MonitorCreate");
    const monitorList = toolMap.get("MonitorList");
    const monitorStop = toolMap.get("MonitorStop");

    await monitorCreate!.execute?.("1", { command: "sleep 1", timeout: 0 });

    let listResult = await monitorList!.execute?.("2", {});
    expect(listResult.content[0].text).toContain("[running]");

    await monitorStop!.execute?.("3", { monitorId: "1" });

    await new Promise(r => setTimeout(r, 200));
    listResult = await monitorList!.execute?.("4", {});
    expect(listResult.content[0].text).toContain("[stopped]");
  });

  it("defaults to session-scoped loop files when PI_LOOP_SCOPE is unset", async () => {
    const { pi, toolMap, extensionHandlers } = createMockPi();

    extension(pi as any);
    await vi.advanceTimersByTimeAsync(6100);
    await Promise.resolve();

    const ctx = {
      ui: { setStatus: vi.fn(), setWidget: vi.fn() },
      hasPendingMessages: () => false,
      sessionManager: { getSessionId: () => "test-session" },
    };
    for (const handler of extensionHandlers.get("turn_start") ?? []) {
      await handler(null, ctx);
    }

    const loopCreate = toolMap.get("LoopCreate");
    expect(loopCreate?.execute).toBeDefined();

    await loopCreate!.execute?.("1", {
      trigger: "tool_execution_start",
      prompt: "Session scoped loop",
      triggerType: "event",
      recurring: true,
    });

    expect(existsSync(join(cwd, ".pi", "loops", "loops-test-session.json"))).toBe(true);
    expect(existsSync(join(cwd, ".pi", "loops", "loops.json"))).toBe(false);
  });

  it("clears memory-scoped loops on non-resume session switch", async () => {
    process.env.PI_LOOP_SCOPE = "memory";
    const { pi, toolMap, extensionHandlers } = createMockPi();

    extension(pi as any);
    await vi.advanceTimersByTimeAsync(6100);
    await Promise.resolve();

    const ctx = {
      ui: { setStatus: vi.fn(), setWidget: vi.fn() },
      hasPendingMessages: () => false,
      sessionManager: { getSessionId: () => "test-session" },
    };
    for (const handler of extensionHandlers.get("turn_start") ?? []) {
      await handler(null, ctx);
    }

    const loopCreate = toolMap.get("LoopCreate");
    const loopList = toolMap.get("LoopList");
    expect(loopCreate?.execute).toBeDefined();
    expect(loopList?.execute).toBeDefined();

    await loopCreate!.execute?.("1", {
      trigger: "tool_execution_start",
      prompt: "Memory scoped loop",
      triggerType: "event",
      recurring: true,
    });

    let listResult = await loopList!.execute?.("2", {});
    expect(listResult.content[0].text).toContain("#1");

    for (const handler of extensionHandlers.get("session_switch") ?? []) {
      await handler({ reason: "switch" }, ctx);
    }

    listResult = await loopList!.execute?.("3", {});
    expect(listResult.content[0].text).toBe("No loops configured. Use LoopCreate to set up a schedule.");
  });
});
