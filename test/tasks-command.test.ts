import { describe, expect, it, vi } from "vitest";
import { registerTasksCommand } from "../src/commands/tasks-command.js";
import { TaskStore } from "../src/task-store.js";
import { createCtx, createMockPi } from "./helpers/mock-pi.js";

function setup(evaluateTaskBacklog = vi.fn(async () => ({ created: false }))) {
  const { pi, commandMap, emittedEvents } = createMockPi();
  const taskStore = new TaskStore(); // memory mode, no file I/O
  const updateWidget = vi.fn();
  registerTasksCommand({
    pi,
    getNativeTaskStore: () => taskStore,
    evaluateTaskBacklog,
    updateWidget,
  });
  const command = commandMap.get("tasks")!;
  return { taskStore, updateWidget, evaluateTaskBacklog, emittedEvents, command };
}

describe("registerTasksCommand", () => {
  it("registers a tasks command with a description", () => {
    const h = setup();
    expect(h.command).toBeDefined();
    expect(h.command.description).toContain("native pi-loop tasks");
  });

  it("warns when native tasks are unavailable (pi-tasks active)", async () => {
    const { pi, commandMap } = createMockPi();
    registerTasksCommand({
      pi,
      getNativeTaskStore: () => undefined,
      evaluateTaskBacklog: vi.fn(async () => ({ created: false })),
      updateWidget: vi.fn(),
    });
    const command = commandMap.get("tasks")!;
    const ctx = createCtx();

    await command.handler!("", ctx);

    expect(ctx.notifications).toEqual([
      { message: "Native tasks are unavailable while pi-tasks is active", level: "warning" },
    ]);
  });

  it("creates a task from a free-text argument string and emits tasks:created", async () => {
    const h = setup();
    const ctx = createCtx();

    await h.command.handler!("fix the flaky test", ctx);

    expect(h.taskStore.list()).toHaveLength(1);
    const entry = h.taskStore.get("1");
    expect(entry?.subject).toBe("fix the flaky test");
    expect(entry?.description).toBe("fix the flaky test");
    expect(h.emittedEvents.some((e) => e.name === "tasks:created" && e.payload.taskId === "1")).toBe(true);
    expect(h.updateWidget).toHaveBeenCalledTimes(1);
    expect(ctx.notifications).toContainEqual({ message: "Task #1 created", level: "info" });
  });

  it("truncates the subject to 80 chars but keeps the full description", async () => {
    const h = setup();
    const long = "x".repeat(120);
    await h.command.handler!(long, createCtx());

    const entry = h.taskStore.get("1");
    expect(entry?.subject).toHaveLength(80);
    expect(entry?.description).toBe(long);
  });

  it("surfaces the backlog-worker note when evaluateTaskBacklog reports a created loop", async () => {
    const h = setup(vi.fn(async () => ({ created: true, entry: { id: "5" } })));
    const ctx = createCtx();

    await h.command.handler!("do the thing", ctx);

    expect(ctx.notifications).toContainEqual({ message: "Task #1 created", level: "info" });
    expect(ctx.notifications).toContainEqual({ message: "Backlog worker loop #5 created", level: "info" });
  });

  it("does not surface a backlog note when evaluateTaskBacklog reports created: false", async () => {
    const h = setup(vi.fn(async () => ({ created: false })));
    const ctx = createCtx();

    await h.command.handler!("do the thing", ctx);

    expect(ctx.notifications).toHaveLength(1);
    expect(ctx.notifications[0].message).toBe("Task #1 created");
  });

  it("no-args invocation lists 0 tasks with a Create option and no other entries", async () => {
    const h = setup();
    const ui = {
      select: vi.fn(async () => undefined),
      input: vi.fn(),
      notify: vi.fn(),
    };
    const ctx = { ui } as any;

    await h.command.handler!("", ctx);

    expect(ui.select).toHaveBeenCalledWith("Tasks", ["+ Create task", "< Back"]);
  });

  it("no-args invocation lists a mixed-status backlog with status icons", async () => {
    const h = setup();
    h.taskStore.create("pending task", "d");
    const t2 = h.taskStore.create("in progress task", "d");
    h.taskStore.start(t2.id);
    const t3 = h.taskStore.create("done task", "d");
    h.taskStore.start(t3.id);
    h.taskStore.complete(t3.id);

    const ui = {
      select: vi.fn(async () => undefined),
      input: vi.fn(),
      notify: vi.fn(),
    };
    const ctx = { ui } as any;

    await h.command.handler!("", ctx);

    expect(ui.select).toHaveBeenCalledWith("Tasks", [
      "+ Create task",
      "* #1 [pending] pending task",
      "> #2 [in_progress] in progress task",
      "ok #3 [completed] done task",
      "< Back",
    ]);
  });

  it("no-args '+ Create task' prompts for subject/description and creates a task", async () => {
    const h = setup();
    const ui = {
      select: vi.fn()
        .mockResolvedValueOnce("+ Create task")
        .mockResolvedValueOnce(undefined), // stop the recursive re-render
      input: vi.fn()
        .mockResolvedValueOnce("New subject")
        .mockResolvedValueOnce("New description"),
      notify: vi.fn(),
    };
    const ctx = { ui } as any;

    await h.command.handler!("", ctx);

    expect(h.taskStore.list()).toHaveLength(1);
    const entry = h.taskStore.get("1");
    expect(entry?.subject).toBe("New subject");
    expect(entry?.description).toBe("New description");
    expect(ui.notify).toHaveBeenCalledWith("Task #1 created", "info");
  });

  it("no-args '+ Create task' defaults description to the subject when left blank", async () => {
    const h = setup();
    const ui = {
      select: vi.fn()
        .mockResolvedValueOnce("+ Create task")
        .mockResolvedValueOnce(undefined),
      input: vi.fn()
        .mockResolvedValueOnce("Just a subject")
        .mockResolvedValueOnce(""), // blank description falls back to subject
      notify: vi.fn(),
    };
    const ctx = { ui } as any;

    await h.command.handler!("", ctx);

    const entry = h.taskStore.get("1");
    expect(entry?.description).toBe("Just a subject");
  });

  it("selecting a task and choosing Complete transitions it and emits tasks:completed", async () => {
    const h = setup();
    h.taskStore.create("subject", "desc");

    const ui = {
      select: vi.fn(async (title: string) => {
        if (title === "Tasks") {
          return h.taskStore.get("1")?.status === "pending" ? "* #1 [pending] subject" : "< Back";
        }
        if (title.startsWith("#1")) return "ok Complete";
        return "< Back";
      }),
      input: vi.fn(),
      notify: vi.fn(),
    };
    const ctx = { ui } as any;

    await h.command.handler!("", ctx);

    expect(h.taskStore.get("1")?.status).toBe("completed");
    expect(h.emittedEvents.some((e) => e.name === "tasks:completed" && e.payload.taskId === "1")).toBe(true);
    expect(h.updateWidget).toHaveBeenCalled();
    expect(h.evaluateTaskBacklog).toHaveBeenCalledWith(h.taskStore, h.taskStore.pendingCount());
    expect(ui.notify).toHaveBeenCalledWith("Task #1 completed", "info");
  });

  it("selecting a task and choosing Delete removes it and emits tasks:deleted", async () => {
    const h = setup();
    h.taskStore.create("subject", "desc");

    const ui = {
      select: vi.fn(async (title: string) => {
        if (title === "Tasks") {
          return h.taskStore.get("1") ? "* #1 [pending] subject" : "< Back";
        }
        if (title.startsWith("#1")) return "x Delete";
        return "< Back";
      }),
      input: vi.fn(),
      notify: vi.fn(),
    };
    const ctx = { ui } as any;

    await h.command.handler!("", ctx);

    expect(h.taskStore.get("1")).toBeUndefined();
    expect(h.emittedEvents.some((e) => e.name === "tasks:deleted" && e.payload.taskId === "1")).toBe(true);
    expect(ui.notify).toHaveBeenCalledWith("Task #1 deleted", "info");
  });
});
