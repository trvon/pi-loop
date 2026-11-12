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

  it("selecting a task and choosing Close without completing transitions it and emits tasks:closed", async () => {
    const h = setup();
    h.taskStore.create("subject", "desc");

    const ui = {
      select: vi.fn(async (title: string) => {
        if (title === "Tasks") {
          return h.taskStore.get("1")?.status === "pending" ? "* #1 [pending] subject" : "< Back";
        }
        if (title.startsWith("#1")) return "x Close without completing";
        return "< Back";
      }),
      input: vi.fn(),
      notify: vi.fn(),
    };
    const ctx = { ui } as any;

    await h.command.handler!("", ctx);

    expect(h.taskStore.get("1")?.status).toBe("closed");
    const event = h.emittedEvents.find((e) => e.name === "tasks:closed" && e.payload.taskId === "1");
    expect(event).toBeDefined();
    expect(event?.payload.previousStatus).toBe("pending");
    expect(ui.notify).toHaveBeenCalledWith("Task #1 closed without completing", "info");
  });

  it("does not report deletion success when a claimed task lacks its token", async () => {
    const h = setup();
    h.taskStore.create("subject", "desc");
    h.taskStore.claim("1", {
      claimId: "claim-1",
      ownerSessionId: "session-a",
      ownerRuntimeId: "runtime-a",
      leaseMs: 60_000,
    });
    let taskVisits = 0;
    const ui = {
      select: vi.fn(async (title: string) => {
        if (title === "Tasks") return taskVisits++ === 0 ? "> #1 [in_progress] subject" : "< Back";
        if (title.startsWith("#1")) return "x Delete";
        return "< Back";
      }),
      input: vi.fn(async () => ""),
      notify: vi.fn(),
    };

    await h.command.handler!("", { ui } as any);

    expect(h.taskStore.get("1")).toBeDefined();
    expect(h.emittedEvents.some((event) => event.name === "tasks:deleted")).toBe(false);
    expect(ui.notify).toHaveBeenCalledWith("Task #1 unchanged: claim token required", "warning");
  });

  // Reproduced bug: an expired claim left /tasks with no action that could succeed.
  function expiredClaimHarness(action: string, confirmed: boolean) {
    const h = setup();
    h.taskStore.create("subject", "desc");
    h.taskStore.claim("1", {
      claimId: "claim-1",
      ownerSessionId: "session-a",
      ownerRuntimeId: "runtime-a",
      leaseMs: 1_000,
      now: Date.now() - 60_000,
    });
    let taskVisits = 0;
    const ui = {
      select: vi.fn(async (title: string) => {
        if (title === "Tasks") return taskVisits++ === 0 ? "> #1 [in_progress] subject" : "< Back";
        if (title.startsWith("#1")) return action;
        return "< Back";
      }),
      input: vi.fn(async () => ""),
      confirm: vi.fn(async () => confirmed),
      notify: vi.fn(),
    };
    return { h, ui };
  }

  it("lets the operator delete a task whose claim lease expired without a token", async () => {
    const { h, ui } = expiredClaimHarness("x Delete", true);

    await h.command.handler!("", { ui } as any);

    expect(h.taskStore.get("1")).toBeUndefined();
    expect(h.emittedEvents.some((event) => event.name === "tasks:deleted")).toBe(true);
    expect(ui.input).not.toHaveBeenCalled();
    expect(ui.confirm).toHaveBeenCalledTimes(1);
    expect(ui.notify).toHaveBeenCalledWith("Task #1 deleted", "info");
  });

  it("lets the operator complete a task whose claim lease expired", async () => {
    const { h, ui } = expiredClaimHarness("ok Complete", true);

    await h.command.handler!("", { ui } as any);

    expect(h.taskStore.get("1")?.status).toBe("completed");
    expect(h.taskStore.get("1")?.claim).toBeUndefined();
    expect(ui.input).not.toHaveBeenCalled();
  });

  it("releases an expired claim back to pending so another worker can take it", async () => {
    const { h, ui } = expiredClaimHarness("* Release to pending", true);

    await h.command.handler!("", { ui } as any);

    expect(h.taskStore.get("1")).toMatchObject({ status: "pending", claim: undefined });
    expect(h.emittedEvents.some((event) => event.name === "tasks:updated" && event.payload.previousStatus === "in_progress")).toBe(true);
    expect(ui.notify).toHaveBeenCalledWith("Task #1 released to pending", "info");
  });

  it("leaves an expired claim untouched when the operator declines the override", async () => {
    const { h, ui } = expiredClaimHarness("x Delete", false);
    const before = structuredClone(h.taskStore.get("1"));

    await h.command.handler!("", { ui } as any);

    expect(h.taskStore.get("1")).toEqual(before);
    expect(h.emittedEvents.some((event) => event.name === "tasks:deleted")).toBe(false);
    expect(ui.notify).toHaveBeenCalledWith("Task #1 unchanged: expired-claim override declined", "warning");
  });

  // Review finding: claim state was sampled before the menu, so a lease that
  // expired while the operator was choosing stayed on the token path.
  it("re-evaluates the claim after the operator chooses, so a lease that expires mid-menu is recoverable", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    try {
      const h = setup();
      h.taskStore.create("subject", "desc");
      h.taskStore.claim("1", { claimId: "claim-1", ownerSessionId: "s", ownerRuntimeId: "r", leaseMs: 60_000 });
      let taskVisits = 0;
      const ui = {
        select: vi.fn(async (title: string) => {
          if (title === "Tasks") return taskVisits++ === 0 ? "> #1 [in_progress] subject" : "< Back";
          vi.advanceTimersByTime(120_000);
          return "ok Complete";
        }),
        input: vi.fn(async () => ""),
        confirm: vi.fn(async () => true),
        notify: vi.fn(),
      };

      await h.command.handler!("", { ui } as any);

      expect(ui.input).not.toHaveBeenCalled();
      expect(ui.confirm).toHaveBeenCalledTimes(1);
      expect(h.taskStore.get("1")).toMatchObject({ status: "completed", claim: undefined });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not release a claim that a worker renewed while the operator was choosing", async () => {
    const { h, ui } = expiredClaimHarness("* Release to pending", true);
    const select = ui.select.getMockImplementation()!;
    ui.select.mockImplementation(async (title: string) => {
      if (title.startsWith("#1")) h.taskStore.claim("1", { claimId: "claim-2", ownerSessionId: "b", ownerRuntimeId: "b", leaseMs: 60_000 });
      return select(title);
    });

    await h.command.handler!("", { ui } as any);

    expect(ui.confirm).not.toHaveBeenCalled();
    expect(h.taskStore.get("1")).toMatchObject({ status: "in_progress", claim: { claimId: "claim-2" } });
    expect(ui.notify).toHaveBeenCalledWith("Task #1 unchanged: its claim is no longer expired", "warning");
  });

  it("reports a task deleted elsewhere while the operator was choosing", async () => {
    const h = setup();
    h.taskStore.create("subject", "desc");
    let taskVisits = 0;
    const ui = {
      select: vi.fn(async (title: string) => {
        if (title === "Tasks") return taskVisits++ === 0 ? "* #1 [pending] subject" : "< Back";
        h.taskStore.delete("1");
        return "ok Complete";
      }),
      input: vi.fn(async () => ""),
      confirm: vi.fn(async () => true),
      notify: vi.fn(),
    };

    await h.command.handler!("", { ui } as any);

    expect(ui.notify).toHaveBeenCalledWith("Task #1 unchanged: Task #1 not found", "warning");
    expect(h.emittedEvents.some((event) => event.name === "tasks:completed")).toBe(false);
  });

  it("never releases a live claim through the operator recovery path", () => {
    const h = setup();
    h.taskStore.create("subject", "desc");
    h.taskStore.claim("1", { claimId: "claim-1", ownerSessionId: "s", ownerRuntimeId: "r", leaseMs: 60_000 });
    const before = structuredClone(h.taskStore.get("1"));

    expect(h.taskStore.releaseExpiredClaim("1", { toPending: true })).toBeUndefined();
    expect(h.taskStore.releaseExpiredClaim("missing")).toBeUndefined();
    expect(h.taskStore.get("1")).toEqual(before);
  });

  it("does not offer release or an override prompt for a live claim", async () => {
    const h = setup();
    h.taskStore.create("subject", "desc");
    h.taskStore.claim("1", { claimId: "claim-1", ownerSessionId: "s", ownerRuntimeId: "r", leaseMs: 60_000 });
    let taskVisits = 0;
    let offered: string[] = [];
    const ui = {
      select: vi.fn(async (title: string, choices: string[]) => {
        if (title === "Tasks") return taskVisits++ === 0 ? "> #1 [in_progress] subject" : "< Back";
        offered = choices;
        return "ok Complete";
      }),
      input: vi.fn(async () => "wrong-token"),
      confirm: vi.fn(async () => true),
      notify: vi.fn(),
    };

    await h.command.handler!("", { ui } as any);

    expect(offered).not.toContain("* Release to pending");
    expect(ui.confirm).not.toHaveBeenCalled();
    expect(h.taskStore.get("1")).toMatchObject({ status: "in_progress", claim: { claimId: "claim-1" } });
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
