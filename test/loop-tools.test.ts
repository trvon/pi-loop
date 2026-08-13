import { beforeEach, describe, expect, it, vi } from "vitest";
import { LoopStore } from "../src/store.js";
import { registerLoopTools } from "../src/tools/loop-tools.js";
import { registerWorkflowTools } from "../src/tools/workflow-tools.js";
import { createMockPi } from "./helpers/mock-pi.js";

function setup() {
  const { pi, toolMap } = createMockPi();
  const store = new LoopStore(); // memory mode, no file I/O
  const triggerSystem = { add: vi.fn(), remove: vi.fn() };
  const scheduler = { nextFire: vi.fn(() => undefined) };
  const monitorManager = { get: vi.fn(() => undefined) };
  const onDynamicLoopActivated = vi.fn();
  const createWorkflowTask = vi.fn(async (_entry: unknown) => undefined as string | undefined);
  const completeWorkflowTask = vi.fn(async (_taskId: string, _claimId?: string) => true);
  const closeWorkflowTask = vi.fn(async (_taskId: string, _claimId?: string) => true);
  const maybeBootstrapTaskLoop = vi.fn(async () => false);
  registerLoopTools({
    pi,
    getStore: () => store as any,
    getTriggerSystem: () => triggerSystem as any,
    getScheduler: () => scheduler as any,
    getMonitorManager: () => monitorManager as any,
    updateWidget: vi.fn(),
    maybeBootstrapTaskLoop,
    isTaskSystemReady: () => true,
    onDynamicLoopActivated,
    closeWorkflowTask,
  });
  registerWorkflowTools({
    pi,
    getStore: () => store,
    getTriggerSystem: () => triggerSystem,
    updateWidget: vi.fn(),
    onDynamicLoopActivated,
    createWorkflowTask,
    completeWorkflowTask,
    closeWorkflowTask,
  });
  const result = async (name: string, args: any) => await toolMap.get(name)!.execute!("t", args);
  const text = async (name: string, args: any) => (await result(name, args)).content[0].text as string;
  return { store, triggerSystem, text, result, toolMap, maybeBootstrapTaskLoop, onDynamicLoopActivated, createWorkflowTask, completeWorkflowTask, closeWorkflowTask };
}

describe("LoopCreate", () => {
  let h: ReturnType<typeof setup>;
  beforeEach(() => {
    h = setup();
  });

  it("creates a cron loop from an interval and arms the trigger system", async () => {
    const out = await h.text("LoopCreate", { trigger: "5m", prompt: "check build", triggerType: "cron" });
    expect(out).toContain("Loop #1 created");
    expect(out).toContain("schedule:");
    expect(out).toContain("Recurring: true");
    expect(h.triggerSystem.add).toHaveBeenCalledTimes(1);
    expect(h.store.get("1")?.trigger.type).toBe("cron");
    expect(h.toolMap.get("LoopCreate")?.renderCall).toBeTypeOf("function");
    expect(h.toolMap.get("LoopCreate")?.renderResult).toBeTypeOf("function");
    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as any;
    expect((h.toolMap.get("LoopCreate") as any).renderCall({ prompt: "check build" }, theme).render(120).map((line: string) => line.trimEnd()))
      .toEqual(["Loop create · check build"]);
  });

  it("creates an event loop that defaults to non-recurring", async () => {
    const out = await h.text("LoopCreate", { trigger: "tasks:created", prompt: "go", triggerType: "event" });
    expect(out).toContain("event: tasks:created");
    expect(out).toContain("Recurring: false");
    expect(h.store.get("1")?.trigger).toEqual({ type: "event", source: "tasks:created" });
  });

  it("makes an explicit task-backlog event loop recurring when omitted", async () => {
    const out = await h.text("LoopCreate", {
      trigger: "tasks:created",
      prompt: "adopt unfinished tasks",
      triggerType: "event",
      taskBacklog: true,
    });

    expect(out).toContain("Recurring: true");
    expect(h.store.get("1")?.recurring).toBe(true);
    expect(h.store.get("1")?.maxFires).toBe(25);
    expect(h.maybeBootstrapTaskLoop).toHaveBeenCalledWith(h.store.get("1"));
  });

  it("rejects non-recurring or non-task event backlog loops", async () => {
    expect(await h.text("LoopCreate", {
      trigger: "tasks:created",
      prompt: "one shot",
      triggerType: "event",
      taskBacklog: true,
      recurring: false,
    })).toContain("taskBacklog loops must be recurring");
    expect(await h.text("LoopCreate", {
      trigger: "tool_execution_start",
      prompt: "wrong event",
      triggerType: "event",
      taskBacklog: true,
    })).toContain('taskBacklog loops require a "tasks:created" event trigger');
    expect(await h.text("LoopCreate", {
      trigger: "idle",
      prompt: "continue a broad goal",
      triggerType: "idle",
      taskBacklog: true,
    })).toContain('For a broad goal, use trigger "idle" with triggerType "idle" and omit taskBacklog.');
    expect(h.store.list()).toHaveLength(0);
  });

  it("creates a hybrid loop", async () => {
    const out = await h.text("LoopCreate", { trigger: "5m", prompt: "go", triggerType: "hybrid" });
    expect(out).toContain("hybrid: cron");
    expect(h.store.get("1")?.trigger.type).toBe("hybrid");
  });

  it("creates an idle-driven loop without a timer and activates its first wake immediately", async () => {
    const out = await h.text("LoopCreate", {
      trigger: "idle",
      prompt: "continue investigating the harness failure",
      triggerType: "idle",
    });

    const entry = h.store.get("1");
    expect(entry?.trigger).toEqual({ type: "dynamic" });
    expect(entry?.recurring).toBe(true);
    expect(entry?.dynamic).toMatchObject({
      goal: "continue investigating the harness failure",
      iteration: 0,
    });
    expect(entry?.dynamic?.nextWakeAt).toBeUndefined();
    expect(h.triggerSystem.add).toHaveBeenCalledWith(entry);
    expect(h.onDynamicLoopActivated).toHaveBeenCalledWith(entry);
    expect(out).toContain("when idle");
  });

  it("does not parse a timer when creating an idle-driven loop", async () => {
    const out = await h.text("LoopCreate", {
      trigger: "5m",
      prompt: "continue investigating the harness failure",
      triggerType: "idle",
    });

    expect(h.store.list()).toHaveLength(0);
    expect(h.triggerSystem.add).not.toHaveBeenCalled();
    expect(h.onDynamicLoopActivated).not.toHaveBeenCalled();
    expect(out).toContain('Idle loops require trigger "idle"');
  });

  it("rejects an empty event source with a validation message", async () => {
    const out = await h.text("LoopCreate", { trigger: "", prompt: "go", triggerType: "event" });
    expect(out).toContain("Invalid event trigger");
    expect(h.triggerSystem.add).not.toHaveBeenCalled();
    expect(h.store.list()).toHaveLength(0);
  });

  it("infers cron from an interval when triggerType is omitted", async () => {
    await h.text("LoopCreate", { trigger: "30s", prompt: "poll" });
    expect(h.store.get("1")?.trigger.type).toBe("cron");
  });

  it("infers cron from a full 5-field cron expression when triggerType is omitted", async () => {
    await h.text("LoopCreate", { trigger: "0 9 * * 1-5", prompt: "morning" });
    expect(h.store.get("1")?.trigger.type).toBe("cron");
  });

  it("infers event from a non-interval source when triggerType is omitted", async () => {
    await h.text("LoopCreate", { trigger: "tool_execution_start", prompt: "react" });
    expect(h.store.get("1")?.trigger).toEqual({ type: "event", source: "tool_execution_start" });
  });

  it("persists readOnly and maxFires flags", async () => {
    await h.text("LoopCreate", { trigger: "5m", prompt: "poll", triggerType: "cron", readOnly: true, maxFires: 20 });
    const entry = h.store.get("1");
    expect(entry?.readOnly).toBe(true);
    expect(entry?.maxFires).toBe(20);
  });

  it("tells agents to preserve recurring and dynamic loop controllers", () => {
    const loopCreate = h.toolMap.get("LoopCreate")!;
    const loopUpdate = h.toolMap.get("LoopUpdate")!;
    const loopDelete = h.toolMap.get("LoopDelete")!;

    expect(loopCreate.description).toContain("A completed iteration, unchanged result, or temporarily empty check is not a reason to delete the loop");
    expect(loopCreate.promptGuidelines).toContain(
      "Recurring loops are persistent controllers. Do not call LoopDelete after a normal fire, an unchanged check, or one completed iteration; only delete when the user explicitly asks to cancel or the loop's stated stop condition is satisfied.",
    );
    expect(loopCreate.promptGuidelines).toContain(
      "For taskBacklog loops, do not instruct the agent to delete the loop; pi-loop auto-deletes it when the pending count reaches zero.",
    );
    expect(loopUpdate.description).toContain("Do not use LoopDelete to finish an iteration");
    expect(loopDelete.description).toContain("Do not use this after a normal loop fire");
  });
});

describe("LoopList", () => {
  it("reports when no loops are configured", async () => {
    const h = setup();
    expect(await h.text("LoopList", {})).toContain("No loops configured");
  });

  it("lists active loops with trigger info", async () => {
    const h = setup();
    await h.text("LoopCreate", { trigger: "5m", prompt: "build check", triggerType: "cron" });
    const out = await h.text("LoopList", {});
    expect(out).toContain("#1");
    expect(out).toContain("[active]");
    expect(out).toContain("cron:");
  });

  it("shows wall-clock age for active loops", async () => {
    const h = setup();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    try {
      await h.text("LoopCreate", { trigger: "5m", prompt: "build check", triggerType: "cron" });
      vi.setSystemTime(new Date("2026-01-01T00:03:00Z"));
      const out = await h.text("LoopList", {});
      expect(out).toContain("age: 3m");
    } finally {
      vi.useRealTimers();
    }
  });

  it("labels wall-clock duration as age after pause and resume", async () => {
    const h = setup();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    try {
      await h.text("LoopCreate", {
        trigger: "5m",
        prompt: "build check",
        triggerType: "cron",
      });
      vi.setSystemTime(new Date("2026-01-01T00:01:00Z"));
      await h.text("LoopDelete", { id: "1", action: "pause" });
      vi.setSystemTime(new Date("2026-01-01T01:00:00Z"));
      h.store.resume("1");

      const out = await h.text("LoopList", {});
      expect(out).toContain("age: 1h");
      expect(out).not.toContain("elapsed:");
    } finally {
      vi.useRealTimers();
    }
  });

  it("omits age for paused loops", async () => {
    const h = setup();
    await h.text("LoopCreate", { trigger: "5m", prompt: "build check", triggerType: "cron" });
    await h.text("LoopDelete", { id: "1", action: "pause" });
    const out = await h.text("LoopList", {});
    expect(out).toContain("[paused]");
    expect(out).not.toContain("age:");
  });
});

describe("LoopUpdate", () => {
  let h: ReturnType<typeof setup>;
  beforeEach(() => {
    h = setup();
    h.store.create({ type: "dynamic" }, "finish goal", {
      recurring: true,
      dynamic: { goal: "finish goal", iteration: 0 },
    });
  });

  it("continues a dynamic loop with progress and next wake", async () => {
    const out = await h.text("LoopUpdate", {
      id: "1",
      status: "continue",
      state: "router done",
      metrics: "2/5 tasks complete",
      doneCriteria: "all tests pass",
      nextInterval: "3m",
    });

    expect(out).toContain("Dynamic loop #1 updated");
    expect(out).toContain("Iteration: 1");
    expect(h.store.get("1")?.dynamic).toMatchObject({
      goal: "finish goal",
      state: "router done",
      metrics: "2/5 tasks complete",
      doneCriteria: "all tests pass",
      iteration: 1,
      awaitingUpdate: false,
    });
    expect(h.store.get("1")?.dynamic?.nextWakeAt).toBeGreaterThan(Date.now());
    expect(h.triggerSystem.remove).toHaveBeenCalledWith("1");
    expect(h.triggerSystem.add).toHaveBeenCalledWith(h.store.get("1"));
  });

  it("completes and deletes a dynamic loop", async () => {
    const out = await h.text("LoopUpdate", { id: "1", status: "completed" });

    expect(out).toBe("Dynamic loop #1 completed and deleted");
    expect(h.store.get("1")).toBeUndefined();
    expect(h.triggerSystem.remove).toHaveBeenCalledWith("1");
  });

  it("pauses a dynamic loop", async () => {
    const out = await h.text("LoopUpdate", { id: "1", status: "paused" });

    expect(out).toBe("Dynamic loop #1 paused");
    expect(h.store.get("1")?.status).toBe("paused");
    expect(h.triggerSystem.remove).toHaveBeenCalledWith("1");
  });

  it("rejects non-dynamic loops", async () => {
    h.store.create({ type: "cron", schedule: "*/5 * * * *" }, "fixed", { recurring: true });

    expect(await h.text("LoopUpdate", { id: "2", status: "continue" })).toBe("Loop #2 is not a dynamic loop");
  });

  it("defaults continued dynamic loops to idle-driven next wake", async () => {
    const out = await h.text("LoopUpdate", { id: "1", status: "continue" });

    expect(out).toContain("Next wake: when idle");
    expect(h.store.get("1")?.dynamic?.nextWakeAt).toBeUndefined();
  });

  it("reports invalid next intervals as structured errors without mutation", async () => {
    const before = h.store.get("1")!;
    before.expiresAt = Date.now() + 1_000;
    h.triggerSystem.add.mockClear();
    h.triggerSystem.remove.mockClear();

    const result = await h.result("LoopUpdate", { id: "1", status: "continue", nextInterval: "soon" });

    expect(result.content[0].text).toContain("Invalid nextInterval");
    expect(result.details).toMatchObject({ tone: "error", summary: "Loop #1 update rejected" });
    expect(h.store.get("1")).toEqual(before);
    expect(h.triggerSystem.add).not.toHaveBeenCalled();
    expect(h.triggerSystem.remove).not.toHaveBeenCalled();

    const overflow = await h.result("LoopUpdate", { id: "1", status: "continue", nextInterval: "999999999999999999999d" });
    expect(overflow.details).toMatchObject({ tone: "error", summary: "Loop #1 update rejected" });
    const beyondLifetime = await h.result("LoopUpdate", { id: "1", status: "continue", nextInterval: "2s" });
    expect(beyondLifetime.content[0].text).toContain("exceeds loop #1's remaining lifetime");
    expect(beyondLifetime.details).toMatchObject({ tone: "error" });
    expect(h.store.get("1")).toEqual(before);
  });

  it("resumes a paused dynamic loop when it continues", async () => {
    await h.text("LoopUpdate", { id: "1", status: "paused" });
    h.triggerSystem.add.mockClear();
    h.triggerSystem.remove.mockClear();

    const out = await h.text("LoopUpdate", { id: "1", status: "continue", state: "blocker resolved" });

    expect(out).toContain("resumed and updated");
    expect(h.store.get("1")?.status).toBe("active");
    expect(h.store.get("1")?.dynamic?.state).toBe("blocker resolved");
    expect(h.triggerSystem.add).toHaveBeenCalledWith(h.store.get("1"));
  });
});

describe("Workflow tools", () => {
  let h: ReturnType<typeof setup>;
  const definition = JSON.stringify({
    version: 1,
    initialState: "investigate",
    states: {
      investigate: { prompt: "Find the cause.", on: { found: "fix" } },
      fix: { prompt: "Fix it.", on: { passing: "done" } },
      done: { prompt: "Report completion.", terminal: "completed" },
    },
  });

  beforeEach(() => {
    h = setup();
  });

  it("rejects a terminal initial state instead of creating an active dead end", async () => {
    const terminalInitial = JSON.stringify({
      version: 1,
      initialState: "done",
      states: {
        done: { prompt: "Nothing remains.", terminal: "completed" },
      },
    });

    const out = await h.text("WorkflowCreate", {
      goal: "Already complete",
      definition: terminalInitial,
    });

    expect(out).toContain("Workflow definition rejected");
    expect(out).toContain('Initial state "done" cannot be terminal');
    expect(h.store.list()).toHaveLength(0);
    expect(h.onDynamicLoopActivated).not.toHaveBeenCalled();
  });

  it("creates an opt-in dynamic workflow and activates its first state", async () => {
    const out = await h.text("WorkflowCreate", { goal: "Fix the regression", definition });

    expect(out).toContain("Workflow #1 created — active");
    expect(out).toContain("Current state: investigate");
    expect(out).toContain("Instruction: Find the cause.");
    expect(out).toContain('WorkflowTransition({ id: "1", outcome: "found", evidence: "..." })');
    expect(out).toContain("Wake: the state instruction will be delivered when the agent becomes idle.");
    expect(h.store.get("1")).toMatchObject({
      trigger: { type: "dynamic" },
      workflow: { currentState: "investigate", transitionSeq: 0 },
    });
    expect(h.triggerSystem.add).toHaveBeenCalledWith(h.store.get("1"));
    expect(h.onDynamicLoopActivated).toHaveBeenCalledWith(h.store.get("1"));
    expect(h.toolMap.get("WorkflowCreate")?.renderCall).toBeTypeOf("function");
    expect(h.toolMap.get("WorkflowTransition")?.renderResult).toBeTypeOf("function");
  });

  it("rejects creation when its initial task cannot bind to the original state", async () => {
    h.createWorkflowTask.mockImplementationOnce(async (entry) => {
      h.store.transitionWorkflow((entry as { id: string }).id, { outcome: "found", evidence: "Concurrent transition." });
      return "12";
    });

    const out = await h.text("WorkflowCreate", { goal: "Fix the regression", definition });

    expect(out).toContain("changed while initial task #12 was created");
    expect(h.closeWorkflowTask).toHaveBeenCalledWith("12");
    expect(h.triggerSystem.add).not.toHaveBeenCalled();
    expect(h.onDynamicLoopActivated).not.toHaveBeenCalled();
  });

  it("creates and records a task declared by the active workflow state", async () => {
    h.createWorkflowTask.mockResolvedValueOnce("12");
    const definitionWithTask = JSON.stringify({
      version: 1,
      initialState: "investigate",
      states: {
        investigate: {
          prompt: "Find the cause.",
          task: { subject: "Investigate regression", description: "Find and reproduce the root cause." },
          on: { found: "done" },
        },
        done: { prompt: "Report completion.", terminal: "completed" },
      },
    });

    const out = await h.text("WorkflowCreate", { goal: "Fix the regression", definition: definitionWithTask });

    expect(out).toContain("Active task: #12");
    expect(h.createWorkflowTask).toHaveBeenCalledWith(expect.objectContaining({ id: "1" }));
    expect(h.store.get("1")?.workflow?.activeTaskId).toBe("12");
  });

  it("closes an active state task before deleting its workflow", async () => {
    h.createWorkflowTask.mockResolvedValueOnce("12");
    await h.text("WorkflowCreate", { goal: "Fix the regression", definition });

    expect(await h.text("LoopDelete", { id: "1", claimId: "claim-12" })).toBe("Loop #1 deleted");
    expect(h.closeWorkflowTask).toHaveBeenCalledWith("12", "claim-12");
    expect(h.store.get("1")).toBeUndefined();
  });

  it("keeps a workflow when its active state task cannot be closed", async () => {
    h.createWorkflowTask.mockResolvedValueOnce("12");
    h.closeWorkflowTask.mockResolvedValueOnce(false);
    await h.text("WorkflowCreate", { goal: "Fix the regression", definition });

    const out = await h.text("LoopDelete", { id: "1", claimId: "stale" });

    expect(out).toContain("could not close active task #12");
    expect(h.store.get("1")).toBeDefined();
  });

  it("lists ordinary loops and full workflow state through LoopList", async () => {
    await h.text("WorkflowCreate", { goal: "Fix the regression", definition });
    await h.text("LoopCreate", { trigger: "5m", prompt: "ordinary loop", triggerType: "cron" });

    const out = await h.text("LoopList", {});

    expect(out).toContain("#1 [active] Fix the regression");
    expect(out).toContain("Current state: investigate");
    expect(out).toContain("Choose outcome: found");
    expect(out).toContain("#2 [active] ordinary loop");
  });

  it("rejects LoopUpdate for workflow-owned dynamic loops", async () => {
    await h.text("WorkflowCreate", { goal: "Fix the regression", definition });
    const before = h.store.get("1");

    const result = await h.result("LoopUpdate", { id: "1", status: "completed" });

    expect(result.content[0].text).toContain("Use WorkflowTransition");
    expect(result.details).toMatchObject({ tone: "error", summary: "Loop #1 update rejected" });
    expect(h.store.get("1")).toEqual(before);
  });

  it("resumes a paused nonterminal workflow when it transitions", async () => {
    await h.text("WorkflowCreate", { goal: "Fix the regression", definition });
    await h.text("LoopDelete", { id: "1", action: "pause" });
    h.triggerSystem.add.mockClear();

    const out = await h.text("WorkflowTransition", { id: "1", outcome: "found", evidence: "Blocker resolved." });

    expect(out).toContain("investigate → fix");
    expect(h.store.get("1")?.status).toBe("active");
    expect(h.triggerSystem.add).toHaveBeenCalledWith(h.store.get("1"));
  });

  it("ignores caller-supplied destination task identifiers", async () => {
    await h.text("WorkflowCreate", { goal: "Fix the regression", definition });

    await h.text("WorkflowTransition", { id: "1", outcome: "found", activeTaskId: "unrelated-task" });

    expect(h.store.get("1")?.workflow?.activeTaskId).toBeUndefined();
  });

  it("transitions only along declared outcomes and re-arms the loop", async () => {
    await h.text("WorkflowCreate", { goal: "Fix the regression", definition });
    h.triggerSystem.add.mockClear();
    h.triggerSystem.remove.mockClear();

    const out = await h.text("WorkflowTransition", {
      id: "1",
      outcome: "found",
      evidence: "Reproduced locally.",
    });

    expect(out).toContain("investigate → fix");
    expect(h.store.get("1")?.workflow).toMatchObject({
      currentState: "fix",
      lastTransition: { evidence: "Reproduced locally." },
    });
    expect(h.triggerSystem.remove).toHaveBeenCalledWith("1");
    expect(h.triggerSystem.add).toHaveBeenCalledWith(h.store.get("1"));
  });

  it("closes the source task only after a successful workflow transition", async () => {
    h.createWorkflowTask.mockResolvedValueOnce("10").mockResolvedValueOnce("11");
    const definitionWithTasks = JSON.stringify({
      version: 1,
      initialState: "investigate",
      states: {
        investigate: {
          prompt: "Find the cause.",
          task: { subject: "Investigate regression", description: "Find the cause." },
          on: { found: "fix" },
        },
        fix: {
          prompt: "Fix it.",
          task: { subject: "Fix regression", description: "Apply the fix." },
          on: { passing: "done" },
        },
        done: { prompt: "Report completion.", terminal: "completed" },
      },
    });
    await h.text("WorkflowCreate", { goal: "Fix the regression", definition: definitionWithTasks });

    await h.text("WorkflowTransition", { id: "1", outcome: "found", claimId: "claim-10" });

    expect(h.completeWorkflowTask).toHaveBeenCalledWith("10", "claim-10");
    expect(h.store.get("1")?.workflow?.activeTaskId).toBe("11");

    await h.text("WorkflowTransition", { id: "1", outcome: "passing", claimId: "claim-11" });
    expect(h.completeWorkflowTask).toHaveBeenLastCalledWith("11", "claim-11");
    expect(h.store.get("1")).toBeUndefined();
  });

  it("creates a fresh linked task and increments the attempt when a workflow self-loops", async () => {
    h.createWorkflowTask.mockResolvedValueOnce("10").mockResolvedValueOnce("11");
    const retryDefinition = JSON.stringify({
      version: 1,
      initialState: "work",
      states: {
        work: {
          prompt: "Run one bounded attempt.",
          task: { subject: "Workflow attempt", description: "Use WorkflowTransition; do not close directly." },
          on: { retry: "work", done: "done" },
          maxAttempts: 3,
        },
        done: { prompt: "Done.", terminal: "completed" },
      },
    });
    await h.text("WorkflowCreate", { goal: "Finish bounded work", definition: retryDefinition });

    const out = await h.text("WorkflowTransition", {
      id: "1",
      outcome: "retry",
      evidence: "The first attempt found another case.",
      claimId: "claim-10",
    });

    expect(out).toContain("work → work");
    expect(out).toContain("Attempt: 2/3");
    expect(h.completeWorkflowTask).toHaveBeenCalledWith("10", "claim-10");
    expect(h.store.get("1")?.workflow).toMatchObject({
      currentState: "work",
      transitionSeq: 1,
      attemptsByState: { work: 2 },
      activeTaskId: "11",
    });
  });

  it("rejects the transition when source task completion is unavailable", async () => {
    h.createWorkflowTask.mockResolvedValueOnce("10").mockResolvedValueOnce("11");
    h.completeWorkflowTask.mockResolvedValueOnce(false);
    const definitionWithTasks = JSON.stringify({
      version: 1,
      initialState: "investigate",
      states: {
        investigate: {
          prompt: "Find the cause.",
          task: { subject: "Investigate regression", description: "Find the cause." },
          on: { found: "fix" },
        },
        fix: {
          prompt: "Fix it.",
          task: { subject: "Fix regression", description: "Apply the fix." },
          on: { passing: "done" },
        },
        done: { prompt: "Report completion.", terminal: "completed" },
      },
    });
    await h.text("WorkflowCreate", { goal: "Fix the regression", definition: definitionWithTasks });

    const before = h.store.get("1");
    const out = await h.text("WorkflowTransition", { id: "1", outcome: "found", claimId: "stale" });

    expect(out).toContain("Source task #10 could not be completed");
    expect(out).toContain("reclaim it and pass claimId");
    expect(h.store.get("1")).toEqual(before);
    expect(h.createWorkflowTask).toHaveBeenCalledTimes(1);
    expect(h.triggerSystem.add).toHaveBeenCalledTimes(1);
  });

  it("rejects a stale transition instead of skipping a concurrently-entered state", async () => {
    h.createWorkflowTask.mockResolvedValueOnce("10");
    await h.text("WorkflowCreate", { goal: "Fix the regression", definition });
    h.completeWorkflowTask.mockImplementationOnce(async () => {
      h.store.transitionWorkflow("1", { outcome: "found", evidence: "Concurrent transition." });
      return true;
    });

    const out = await h.text("WorkflowTransition", { id: "1", outcome: "found", claimId: "claim-10" });

    expect(out).toContain("Workflow #1 changed; inspect LoopList and retry");
    expect(h.store.get("1")?.workflow?.currentState).toBe("fix");
    expect(h.store.get("1")?.workflow?.transitionSeq).toBe(1);
  });

  it("closes an unbound destination task when the workflow advances concurrently", async () => {
    h.createWorkflowTask
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(async () => {
        h.store.transitionWorkflow("1", { outcome: "passing", evidence: "Concurrent completion." });
        return "11";
      });
    await h.text("WorkflowCreate", { goal: "Fix the regression", definition });

    const out = await h.text("WorkflowTransition", { id: "1", outcome: "found" });

    expect(out).toContain("changed while destination task #11 was created");
    expect(h.closeWorkflowTask).toHaveBeenCalledWith("11");
    expect(h.store.get("1")?.workflow?.currentState).toBe("done");
    expect(h.store.get("1")?.workflow?.activeTaskId).toBeUndefined();
  });

  it("rejects an undeclared outcome without changing or re-arming the workflow", async () => {
    await h.text("WorkflowCreate", { goal: "Fix the regression", definition });
    h.triggerSystem.add.mockClear();
    h.triggerSystem.remove.mockClear();

    const out = await h.text("WorkflowTransition", { id: "1", outcome: "ship_it" });
    expect(out).toContain("Workflow #1 did not transition");
    expect(out).toContain('Reason: Outcome "ship_it" is not allowed from state "investigate"');
    expect(out).toContain("Workflow #1 remains — active");
    expect(out).toContain("Choose outcome: found");
    expect(h.store.get("1")?.workflow?.currentState).toBe("investigate");
    expect(h.triggerSystem.remove).not.toHaveBeenCalled();
    expect(h.completeWorkflowTask).not.toHaveBeenCalled();
  });

  it("completes and deletes a workflow when it reaches a completed terminal state", async () => {
    await h.text("WorkflowCreate", { goal: "Fix the regression", definition });
    await h.text("WorkflowTransition", { id: "1", outcome: "found" });

    const out = await h.text("WorkflowTransition", { id: "1", outcome: "passing" });
    expect(out).toContain("Workflow #1 completed and deleted");
    expect(out).toContain("Final transition: fix → done");
    expect(h.store.get("1")).toBeUndefined();
  });

  it("does not suggest resuming a workflow paused in a terminal state", async () => {
    const pausedDefinition = JSON.stringify({
      version: 1,
      initialState: "investigate",
      states: {
        investigate: { prompt: "Find the blocker.", on: { blocked: "blocked" } },
        blocked: { prompt: "Report the blocker.", terminal: "paused" },
      },
    });
    await h.text("WorkflowCreate", {
      goal: "Investigate the blocker",
      definition: pausedDefinition,
    });

    const out = await h.text("WorkflowTransition", {
      id: "1",
      outcome: "blocked",
      evidence: "Credentials are unavailable.",
    });

    expect(out).toContain("Workflow #1 paused");
    expect(out).toContain("Terminal workflow states cannot be resumed");
    expect(out).not.toContain("resume or delete");
    expect(h.store.get("1")?.status).toBe("paused");
  });

  it("explains how to recover from an invalid workflow definition", async () => {
    const out = await h.text("WorkflowCreate", { goal: "Fix the regression", definition: "{}" });

    expect(out).toContain("Workflow definition rejected: Workflow version must be 1");
    expect(out).toContain("Required fields: version: 1, initialState, and states.");
    expect(out).toContain('"initialState":"investigate"');
    expect(out).toContain("Next: correct the JSON and call WorkflowCreate again.");
  });

  it("guides users when no loops or workflows exist without registering WorkflowList", async () => {
    expect(h.toolMap.has("WorkflowList")).toBe(false);
    expect(await h.text("LoopList", {})).toBe("No loops configured. Use LoopCreate to set up a schedule.");
  });

  it("shows the last transition and its evidence in workflow listings", async () => {
    await h.text("WorkflowCreate", { goal: "Fix the regression", definition });
    await h.text("WorkflowTransition", { id: "1", outcome: "found", evidence: "Reproduced locally." });

    const out = await h.text("LoopList", {});
    expect(out).toContain("Last transition: investigate → fix via found");
    expect(out).toContain("Evidence: Reproduced locally.");
  });

  it("keeps valid outcomes available when another target exhausts its attempt limit", async () => {
    const limited = JSON.stringify({
      version: 1,
      initialState: "investigate",
      states: {
        investigate: { prompt: "Find the cause.", on: { found: "fix" }, maxAttempts: 1 },
        fix: { prompt: "Fix it.", on: { regression_found: "investigate", passing: "done" } },
        done: { prompt: "Report.", terminal: "completed" },
      },
    });
    await h.text("WorkflowCreate", { goal: "Fix the regression", definition: limited });
    await h.text("WorkflowTransition", { id: "1", outcome: "found" });

    const out = await h.text("WorkflowTransition", { id: "1", outcome: "regression_found" });
    expect(out).toContain("exhausted its 1 attempt limit");
    expect(out).toContain("Unavailable outcome: regression_found");
    expect(out).toContain("Choose outcome: passing");
    expect(out).toContain('WorkflowTransition({ id: "1", outcome: "passing"');
    expect(out).not.toContain("Choose outcome: regression_found");
    expect(out).not.toContain("LoopDelete");
  });

  it("guides pause or deletion when all outcomes target exhausted states", async () => {
    const limited = JSON.stringify({
      version: 1,
      initialState: "investigate",
      states: {
        investigate: { prompt: "Find the cause.", on: { found: "fix" }, maxAttempts: 1 },
        fix: { prompt: "Fix it.", on: { regression_found: "investigate" } },
      },
    });
    await h.text("WorkflowCreate", { goal: "Fix the regression", definition: limited });
    await h.text("WorkflowTransition", { id: "1", outcome: "found" });

    const out = await h.text("WorkflowTransition", {
      id: "1",
      outcome: "regression_found",
    });

    expect(out).toContain("all declared outcomes are unavailable");
    expect(out).toContain("LoopDelete");
    expect(out).not.toContain("Next: WorkflowTransition");
  });

  it("documents per-state tasks and state-prompt authoring in WorkflowCreate guidance", () => {
    const tool = h.toolMap.get("WorkflowCreate") as any;
    const description = tool.description as string;
    const guidelines = tool.promptGuidelines as string[];

    expect(description).toContain("task: {subject, description}");
    expect(guidelines.some((g) => g.includes("evidence"))).toBe(true);
    expect(guidelines.some((g) => g.includes("rework"))).toBe(true);
    expect(guidelines.some((g) => g.includes("maxAttempts"))).toBe(true);
  });
});

describe("LoopDelete", () => {
  let h: ReturnType<typeof setup>;
  beforeEach(async () => {
    h = setup();
    await h.text("LoopCreate", { trigger: "5m", prompt: "x", triggerType: "cron" });
  });

  it("deletes a loop and removes its trigger", async () => {
    const out = await h.text("LoopDelete", { id: "1", action: "delete" });
    expect(out).toBe("Loop #1 deleted");
    expect(h.triggerSystem.remove).toHaveBeenCalledWith("1");
    expect(h.store.get("1")).toBeUndefined();
  });

  it("pauses a loop without removing it", async () => {
    const out = await h.text("LoopDelete", { id: "1", action: "pause" });
    expect(out).toBe("Loop #1 paused");
    expect(h.store.get("1")?.status).toBe("paused");
  });

  it("reports auto-deletion tombstones for already deleted loops", async () => {
    h.store.recordDeletionTombstone("1", { reason: "task_backlog_empty", pendingCount: 0 });
    h.store.delete("1");

    expect(await h.text("LoopDelete", { id: "1", action: "delete" })).toBe("Loop #1 already auto-deleted: task_backlog_empty (pending: 0)");
  });

  it("reports auto-deletion tombstones consistently when pausing", async () => {
    h.store.recordDeletionTombstone("1", { reason: "task_backlog_empty", pendingCount: 0 });
    h.store.delete("1");

    expect(await h.text("LoopDelete", { id: "1", action: "pause" })).toBe("Loop #1 already auto-deleted: task_backlog_empty (pending: 0)");
  });

  it("reports not found for an unknown id", async () => {
    expect(await h.text("LoopDelete", { id: "99", action: "delete" })).toBe("Loop #99 not found");
  });
});
