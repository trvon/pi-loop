import { beforeEach, describe, expect, it, vi } from "vitest";
import { LoopStore } from "../src/store.js";
import { registerLoopTools } from "../src/tools/loop-tools.js";
import { createMockPi } from "./helpers/mock-pi.js";

function setup() {
  const { pi, toolMap } = createMockPi();
  const store = new LoopStore(); // memory mode, no file I/O
  const triggerSystem = { add: vi.fn(), remove: vi.fn() };
  const scheduler = { nextFire: vi.fn(() => undefined) };
  const monitorManager = { get: vi.fn(() => undefined) };
  const onDynamicLoopActivated = vi.fn();
  const createWorkflowTask = vi.fn(async () => undefined);
  const completeWorkflowTask = vi.fn(async () => true);
  registerLoopTools({
    pi,
    getStore: () => store as any,
    getTriggerSystem: () => triggerSystem as any,
    getScheduler: () => scheduler as any,
    getMonitorManager: () => monitorManager as any,
    updateWidget: vi.fn(),
    maybeBootstrapTaskLoop: vi.fn(async () => false),
    isTaskSystemReady: () => true,
    onDynamicLoopActivated,
    createWorkflowTask,
    completeWorkflowTask,
  });
  const text = async (name: string, args: any) =>
    (await toolMap.get(name)!.execute!("t", args)).content[0].text as string;
  return { store, triggerSystem, text, toolMap, onDynamicLoopActivated, createWorkflowTask, completeWorkflowTask };
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
  });

  it("creates an event loop that defaults to non-recurring", async () => {
    const out = await h.text("LoopCreate", { trigger: "tasks:created", prompt: "go", triggerType: "event" });
    expect(out).toContain("event: tasks:created");
    expect(out).toContain("Recurring: false");
    expect(h.store.get("1")?.trigger).toEqual({ type: "event", source: "tasks:created" });
  });

  it("creates a hybrid loop", async () => {
    const out = await h.text("LoopCreate", { trigger: "5m", prompt: "go", triggerType: "hybrid" });
    expect(out).toContain("hybrid: cron");
    expect(h.store.get("1")?.trigger.type).toBe("hybrid");
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

  it("reports invalid next intervals", async () => {
    const out = await h.text("LoopUpdate", { id: "1", status: "continue", nextInterval: "soon" });
    expect(out).toContain("Invalid nextInterval");
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

  it("lists workflow state, active task, and next outcomes without mixing in ordinary loops", async () => {
    await h.text("WorkflowCreate", { goal: "Fix the regression", definition });
    await h.text("LoopCreate", { trigger: "5m", prompt: "ordinary loop", triggerType: "cron" });

    const out = await h.text("WorkflowList", {});

    expect(out).toContain("1 workflow configured");
    expect(out).toContain("Workflow #1 — active");
    expect(out).toContain("Current state: investigate");
    expect(out).toContain("Choose outcome: found");
    expect(out).not.toContain("ordinary loop");
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

    await h.text("WorkflowTransition", { id: "1", outcome: "found" });

    expect(h.completeWorkflowTask).toHaveBeenCalledWith("10");
    expect(h.store.get("1")?.workflow?.activeTaskId).toBe("11");

    await h.text("WorkflowTransition", { id: "1", outcome: "passing" });
    expect(h.completeWorkflowTask).toHaveBeenLastCalledWith("11");
    expect(h.store.get("1")).toBeUndefined();
  });

  it("continues the workflow when source task completion is unavailable", async () => {
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

    const out = await h.text("WorkflowTransition", { id: "1", outcome: "found" });

    expect(out).toContain("investigate → fix");
    expect(h.store.get("1")?.workflow?.activeTaskId).toBe("11");
    expect(h.triggerSystem.add).toHaveBeenCalledWith(h.store.get("1"));
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

  it("explains how to recover from an invalid workflow definition", async () => {
    const out = await h.text("WorkflowCreate", { goal: "Fix the regression", definition: "{}" });

    expect(out).toContain("Workflow definition rejected: Workflow version must be 1");
    expect(out).toContain("Required fields: version: 1, initialState, and states.");
    expect(out).toContain('"initialState":"investigate"');
    expect(out).toContain("Next: correct the JSON and call WorkflowCreate again.");
  });

  it("guides users when no workflows exist", async () => {
    const out = await h.text("WorkflowList", {});

    expect(out).toContain("No workflow loops configured.");
    expect(out).toContain("use WorkflowCreate for explicit state-and-outcome work");
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
