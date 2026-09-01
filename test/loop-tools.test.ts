import { beforeEach, describe, expect, it, vi } from "vitest";
import { LoopStore } from "../src/store.js";
import { registerLoopTools } from "../src/tools/loop-tools.js";
import { formatWorkflowSummary, registerWorkflowTools } from "../src/tools/workflow-tools.js";
import { createMockPi } from "./helpers/mock-pi.js";

function setup() {
  const { pi, toolMap } = createMockPi();
  const store = new LoopStore(); // memory mode, no file I/O
  const triggerSystem = { add: vi.fn(), remove: vi.fn() };
  const scheduler = { nextFire: vi.fn(() => undefined) };
  const monitorManager = { get: vi.fn(() => undefined) };
  const onDynamicLoopActivated = vi.fn();
  const admissionProviders: import("../src/workflow-admission.js").WorkflowAdmissionProvider[] = [];
  const maybeBootstrapTaskLoop = vi.fn(async () => false);
  const isTaskSystemReady = vi.fn(() => true);
  const cancelOrchestration = vi.fn(async (id: string, action: "pause" | "delete") => {
    if (action === "delete") return store.delete(id);
    return store.pause(id) !== undefined;
  });
  registerLoopTools({
    pi,
    getStore: () => store as any,
    getTriggerSystem: () => triggerSystem as any,
    getScheduler: () => scheduler as any,
    getMonitorManager: () => monitorManager as any,
    updateWidget: vi.fn(),
    maybeBootstrapTaskLoop,
    isTaskSystemReady,
    onDynamicLoopActivated,
    cancelOrchestration,
  });
  registerWorkflowTools({
    pi,
    getStore: () => store,
    getTriggerSystem: () => triggerSystem,
    getActor: () => ({ sessionId: "test-session", runtimeId: "test-runtime" }),
    getAdmissionContextDigest: () => "workspace-A",
    getAdmissionProviders: () => admissionProviders,
    updateWidget: vi.fn(),
    onDynamicLoopActivated,
  });
  const result = async (name: string, args: any) => await toolMap.get(name)!.execute!("t", args);
  const text = async (name: string, args: any) => (await result(name, args)).content[0].text as string;
  return { store, triggerSystem, text, result, toolMap, admissionProviders, maybeBootstrapTaskLoop, isTaskSystemReady, onDynamicLoopActivated, cancelOrchestration };
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

  it("rejects autoTask on a task-backlog worker", async () => {
    const out = await h.text("LoopCreate", {
      trigger: "tasks:created",
      prompt: "adopt unfinished tasks",
      triggerType: "event",
      taskBacklog: true,
      autoTask: true,
    });

    expect(out).toContain("taskBacklog loops cannot enable autoTask");
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
    const loopCreate = h.toolMap.get("LoopCreate");
    const loopUpdate = h.toolMap.get("LoopUpdate");
    const loopDelete = h.toolMap.get("LoopDelete");
    expect(loopCreate).toBeDefined();
    expect(loopUpdate).toBeDefined();
    expect(loopDelete).toBeDefined();
    if (!loopCreate || !loopUpdate || !loopDelete) throw new Error("loop tools were not registered");
    const promptGuidelines = loopCreate.promptGuidelines;
    expect(Array.isArray(promptGuidelines)).toBe(true);
    if (!Array.isArray(promptGuidelines)) throw new Error("LoopCreate promptGuidelines were not registered");
    const guidance = promptGuidelines.join("\n");

    expect(loopCreate.description).toContain("A completed iteration, unchanged result, or temporarily empty check is not a reason to delete the loop");
    expect(guidance).toContain(
      "Use LoopDelete only for explicit cancellation or a satisfied stop condition",
    );
    expect(guidance).toContain("Report the created loop ID");
    expect(guidance).toContain(
      "never combine taskBacklog with autoTask or manually delete its loop",
    );
    expect(loopUpdate.description).toContain("never use LoopDelete to finish an iteration");
    expect(loopDelete.description).toContain("Do neither after a normal, empty, or unchanged iteration");
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

  it("shows the stable expiry boundary for recurring loops", async () => {
    const h = setup();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    try {
      await h.text("LoopCreate", { trigger: "5m", prompt: "build check", triggerType: "cron" });
      const out = await h.text("LoopList", {});
      expect(out).toContain("expiresAt: 2026-01-08T00:00:00.000Z");
    } finally {
      vi.useRealTimers();
    }
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

  it("shows workflow activity, workflow age, and current-state age", async () => {
    const h = setup();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    try {
      h.store.create({ type: "dynamic" }, "Ship activity UX", {
        recurring: true,
        workflow: {
          version: 1,
          initialState: "work",
          states: {
            work: {
              prompt: "Work.",
              task: { subject: "Work", description: "Implement." },
              on: { done: "done" },
            },
            done: { prompt: "Done.", terminal: "completed" },
          },
        },
      });
      vi.advanceTimersByTime(90_000);

      const idle = await h.text("LoopList", {});
      expect(idle).toContain("[active] Ship activity UX");
      expect(idle).toContain("[activity:idle 2m]");
      expect(idle).toContain("age: 2m");
      expect(idle).toContain("[workflow:work 2m]");

      h.store.get("1")!.workflow!.activeExecution!.lease = {
        ownerSessionId: "session",
        ownerRuntimeId: "runtime",
        acquiredAt: Date.now() - 30_000,
        heartbeatAt: Date.now() - 20_000,
        expiresAt: Date.now() - 10_000,
        attempt: 1,
      };
      const expired = await h.text("LoopList", {});
      expect(expired).toContain("[activity:idle 10s]");
      expect(expired).toContain("Lease: expired at");
      expect(expired).toContain("Next: WorkflowClaim");

      h.store.pause("1", "administrative", "waiting for approval");
      vi.advanceTimersByTime(30_000);
      const paused = await h.text("LoopList", {});
      expect(paused).toContain("[paused] Ship activity UX");
      expect(paused).toContain("[activity:paused 30s]");
      expect(paused).toContain("age: 2m");
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows orchestration progress as its own controller kind", async () => {
    const h = setup();
    h.store.create({ type: "dynamic" }, "Parallel review", {
      recurring: true,
      orchestration: {
        owner: { sessionId: "s", runtimeId: "r", generation: 1 },
        definition: { goal: "Parallel review", work: [{ prompt: "Inspect" }] },
      },
    });

    const out = await h.text("LoopList", {});
    expect(out).toContain("[orchestration:active]");
    expect(out).toContain("pending=1 active=0 completed=0 failed=0 uncertain=0");
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

  it("rejects orchestration-owned dynamic state", async () => {
    h.store.delete("1");
    h.store.create({ type: "dynamic" }, "Parallel review", {
      recurring: true,
      orchestration: {
        owner: { sessionId: "s", runtimeId: "r", generation: 1 },
        definition: { goal: "Parallel review", work: [{ prompt: "Inspect" }] },
      },
    });

    expect(await h.text("LoopUpdate", { id: "2", status: "continue" })).toContain("orchestration-owned");
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

  it("rejects continuing an expired dynamic controller", async () => {
    h.store.get("1")!.expiresAt = Date.now();
    h.triggerSystem.add.mockClear();

    const out = await h.text("LoopUpdate", { id: "1", status: "continue" });

    expect(out).toContain("has expired; recreate it explicitly");
    expect(h.store.get("1")?.dynamic?.iteration).toBe(0);
    expect(h.triggerSystem.add).not.toHaveBeenCalled();
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
  const taskDefinition = JSON.stringify({
    version: 1,
    initialState: "investigate",
    states: {
      investigate: {
        prompt: "Find the cause.",
        task: { subject: "Investigate regression", description: "Find the root cause." },
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

  beforeEach(() => {
    h = setup();
  });

  it("rejects a terminal initial state", async () => {
    const out = await h.text("WorkflowCreate", {
      goal: "Already complete",
      definition: JSON.stringify({ version: 1, initialState: "done", states: { done: { prompt: "Nothing remains.", terminal: "completed" } } }),
    });
    expect(out).toContain('Initial state "done" cannot be terminal');
    expect(h.store.list()).toHaveLength(0);
  });

  it("rejects a self-loop without maxAttempts", async () => {
    const out = await h.text("WorkflowCreate", {
      goal: "Await authority",
      definition: JSON.stringify({
        version: 1,
        initialState: "wait",
        states: {
          wait: { prompt: "Wait.", on: { still_missing: "wait", received: "done" } },
          done: { prompt: "Done.", terminal: "completed" },
        },
      }),
    });

    expect(out).toContain('State "wait" self-loop "still_missing" requires maxAttempts');
    expect(h.store.list()).toHaveLength(0);
    expect((h.toolMap.get("WorkflowCreate") as any).promptGuidelines.join("\n")).toContain("every self-loop needs maxAttempts");
  });

  it("creates and activates a workflow controller", async () => {
    const out = await h.text("WorkflowCreate", { goal: "Fix the regression", definition });
    expect(out).toContain("Workflow #1 created — active");
    expect(out).toContain("Current state: investigate");
    expect(h.store.get("1")).toMatchObject({ trigger: { type: "dynamic" }, workflow: { currentState: "investigate", transitionSeq: 0 } });
    expect(h.triggerSystem.add).toHaveBeenCalledWith(h.store.get("1"));
    expect(h.onDynamicLoopActivated).toHaveBeenCalledWith(h.store.get("1"));
  });

  it("renders authoritative paused state when creation activation reaches its cap", async () => {
    h.onDynamicLoopActivated.mockImplementationOnce((entry) => {
      h.store.fire(entry.id);
      h.store.pause(entry.id, "controller_limit", "loop fire cap reached");
    });

    const result = await h.result("WorkflowCreate", {
      goal: "Fix the regression",
      definition: taskDefinition,
      maxFires: 1,
    });
    const out = result.content[0].text as string;

    expect(h.store.get("1")?.status).toBe("paused");
    expect(out).toContain("Workflow #1 created — paused");
    expect(out).toContain("no next wake is scheduled");
    expect(out).not.toContain("Next: WorkflowClaim");
    expect(result.details).toMatchObject({ tone: "warning" });
    expect(h.triggerSystem.remove).toHaveBeenCalledWith("1");
  });

  it("renders workflow lifecycle results as compact expandable rows", async () => {
    const createResult = await h.result("WorkflowCreate", { goal: "Fix the regression", definition: taskDefinition });
    expect(createResult.details).toMatchObject({
      kind: "workflow",
      action: "create",
      tone: "success",
      summary: expect.stringContaining("Workflow #1 active · investigate · attempt 1 · running"),
    });
    expect(createResult.details.expanded).toEqual(expect.arrayContaining([
      "Goal: Fix the regression",
      "State: investigate · revision 1 · transition 0",
      expect.stringContaining("Outcomes: found"),
    ]));

    const transitionResult = await h.result("WorkflowTransition", { id: "1", outcome: "found", evidence: "Reproduced." });
    expect(transitionResult.details).toMatchObject({
      kind: "workflow",
      action: "transition",
      tone: "success",
      summary: expect.stringContaining("Workflow #1 advanced · investigate → fix · idle"),
    });

    const claimResult = await h.result("WorkflowClaim", { id: "1" });
    expect(claimResult.details).toMatchObject({
      kind: "workflow",
      action: "claim",
      tone: "success",
      summary: expect.stringContaining("Workflow #1 lease active · fix · running"),
    });

    const reviseResult = await h.result("WorkflowRevise", {
      id: "1",
      expectedRevision: 1,
      expectedState: "fix",
      expectedTransitionSeq: 1,
      reason: "Clarify retry work.",
      changes: [{ op: "revise_state", stateId: "investigate", prompt: "Investigate revised requirements." }],
    });
    expect(reviseResult.details).toMatchObject({
      kind: "workflow",
      action: "revise",
      tone: "success",
      summary: expect.stringContaining("Workflow #1 revised · r1 → r2 · running"),
    });
  });

  it("renders workflow rejections with compact recovery details", async () => {
    const result = await h.result("WorkflowClaim", { id: "99" });
    expect(result.details).toMatchObject({
      kind: "workflow",
      action: "claim",
      tone: "error",
      summary: "Workflow #99 claim rejected",
      expanded: [expect.stringContaining("Loop #99 not found")],
    });
  });

  it("keeps transitioned workflow recovery details in bounded LoopList presentation", async () => {
    await h.result("WorkflowCreate", { goal: "Fix the regression", definition: taskDefinition });
    await h.result("WorkflowTransition", { id: "1", outcome: "found", evidence: "Reproduced." });
    const list = await h.result("LoopList", {});
    expect(list.details).toMatchObject({
      kind: "loop",
      action: "list",
      tone: "info",
      summary: "1 workflow · 1 active",
    });
    expect(list.details.expanded).toContainEqual(expect.stringContaining("Lease: unowned"));
    expect(list.details.expanded).toContainEqual(expect.stringContaining("Choose outcome: passing"));
    expect(list.details.expanded).toContainEqual(expect.stringContaining("Next: WorkflowClaim"));
  });

  it("embeds initial task work without creating an external task", async () => {
    const out = await h.text("WorkflowCreate", { goal: "Fix the regression", definition: taskDefinition });
    expect(out).toContain("Active workflow work: Investigate regression (investigate:0)");
    expect(h.store.get("1")?.workflow).toMatchObject({
      activeExecution: {
        id: "investigate:0",
        stateId: "investigate",
        status: "active",
        lease: { ownerSessionId: "test-session", ownerRuntimeId: "test-runtime" },
      },
    });
  });

  it("atomically settles source work and leaves destination work claimable", async () => {
    await h.text("WorkflowCreate", { goal: "Fix the regression", definition: taskDefinition });
    const out = await h.text("WorkflowTransition", { id: "1", outcome: "found", evidence: "Reproduced locally." });
    expect(out).toContain("investigate → fix");
    expect(out).toContain("Lease: unowned; claim it before continuing.");
    expect(h.store.get("1")?.workflow).toMatchObject({
      currentState: "fix",
      transitionSeq: 1,
      activeExecution: { id: "fix:1", status: "active", subject: "Fix regression" },
      executionHistory: [{ id: "investigate:0", status: "completed", evidence: "Reproduced locally." }],
    });
    expect(h.store.get("1")?.workflow?.activeExecution?.lease).toBeUndefined();
  });

  it("requires trusted blocker admission before a paused terminal transition", async () => {
    const definition = JSON.stringify({
      version: 1,
      initialState: "work",
      states: {
        work: { prompt: "Check release.", on: { blocked: "blocked" } },
        blocked: { prompt: "Report blocker.", terminal: "paused" },
      },
    });
    await h.text("WorkflowCreate", { goal: "Check release", definition });

    const rejected = await h.text("WorkflowTransition", { id: "1", outcome: "blocked" });

    expect(rejected).toContain("Admission: unresolved (claim_required)");
    expect(h.store.get("1")).toMatchObject({ status: "active", workflow: { currentState: "work" } });
  });

  it("admits a paused terminal transition through a trusted provider", async () => {
    const definition = JSON.stringify({
      version: 1,
      initialState: "work",
      states: {
        work: { prompt: "Check release.", on: { blocked: "blocked" } },
        blocked: { prompt: "Report blocker.", terminal: "paused" },
      },
    });
    h.admissionProviders.push({
      id: "test",
      sourceClass: "environmental",
      async observe({ claim, context, now }) {
        return [{
          fact: claim.fact,
          actual: true,
          sourceClass: "environmental",
          provider: "test",
          providerVersion: "1",
          observedAt: now,
          expiresAt: now + 1_000,
          context,
          status: "observed",
        }];
      },
    });
    await h.text("WorkflowCreate", { goal: "Check release", definition });

    const admitted = await h.text("WorkflowTransition", {
      id: "1",
      outcome: "blocked",
      claim: { class: "environmental", provider: "test", subject: "release", fact: "failed", expected: true },
    });

    expect(admitted).toContain("Workflow #1 paused");
    expect(h.store.get("1")?.pause?.kind).toBe("semantic_terminal");
    const listed = await h.text("LoopList", {});
    expect(listed).toContain("Pause cause: semantic_terminal");
    expect(listed).toContain("Admission: environmental · test:release.failed = true · test@1");

    const reissue = await h.text("WorkflowRevise", {
      id: "1",
      expectedRevision: 1,
      expectedState: "blocked",
      expectedTransitionSeq: 1,
      reason: "Do not reopen terminal work.",
      changes: [{ op: "reissue_state", stateId: "blocked", prompt: "Changed." }],
    });
    expect(reissue).toContain("Code: terminal_workflow");
    expect(reissue).not.toContain("Resume the workflow through /loop");
  });

  it("exposes typed workflow revision changes without raw replacement or ownership fields", () => {
    const revise = h.toolMap.get("WorkflowRevise") as any;

    expect(revise).toBeDefined();
    expect(revise.parameters.properties).toMatchObject({
      expectedRevision: expect.any(Object),
      expectedState: expect.any(Object),
      expectedTransitionSeq: expect.any(Object),
      reason: expect.any(Object),
      changes: expect.any(Object),
    });
    expect(revise.parameters.properties.definition).toBeUndefined();
    expect(revise.parameters.properties.actor).toBeUndefined();
    expect(revise.parameters.properties.claimId).toBeUndefined();
    expect(revise.description).toContain("typed CAS changes");
    expect(JSON.stringify(revise.parameters.properties.changes)).toContain("reissue_state");
    expect(revise.promptGuidelines.join("\n")).toContain("Non-task WorkflowRevise needs no claim");
    expect(revise.promptGuidelines.join("\n")).toContain("use WorkflowClaim only for unowned/expired task work");
    expect(revise.promptGuidelines.join("\n")).toContain("Never create standalone tasks");
    expect(revise.promptGuidelines.join("\n")).toContain("Never park under ignored instructions");
  });

  it("routes attempted current-state mutation to explicit reissue", async () => {
    await h.text("WorkflowCreate", { goal: "Fix the regression", definition: taskDefinition });

    const out = await h.text("WorkflowRevise", {
      id: "1",
      expectedRevision: 1,
      expectedState: "investigate",
      expectedTransitionSeq: 0,
      reason: "The current prompt is stale.",
      changes: [{ op: "revise_state", stateId: "investigate", prompt: "Wait for Brick." }],
    });

    expect(out).toContain("Code: current_state_immutable");
    expect(out).toContain("Use reissue_state to atomically replace active instructions");
    expect(h.store.get("1")?.workflow?.definitionRevision).toBe(1);
  });

  it("reissues administrative pauses without waking, but rejects exhausted controllers", async () => {
    await h.text("WorkflowCreate", { goal: "Fix the regression", definition: taskDefinition });
    h.store.pause("1", "administrative", "Hold.");
    h.triggerSystem.add.mockClear();
    h.triggerSystem.remove.mockClear();
    h.onDynamicLoopActivated.mockClear();

    const out = await h.text("WorkflowRevise", {
      id: "1",
      expectedRevision: 1,
      expectedState: "investigate",
      expectedTransitionSeq: 0,
      reason: "Replace paused instructions.",
      changes: [{ op: "reissue_state", stateId: "investigate", prompt: "Changed." }],
    });

    expect(out).toContain("Reissued active state: investigate");
    expect(out).toContain("resume through /loop to wake the fresh instruction");
    expect(out).toContain("superseded prompt will not run");
    expect(h.store.get("1")).toMatchObject({
      status: "paused",
      workflow: { definitionRevision: 2, activeExecution: { id: "investigate:0:r2" } },
    });
    expect(h.triggerSystem.add).not.toHaveBeenCalled();
    expect(h.triggerSystem.remove).not.toHaveBeenCalled();
    expect(h.onDynamicLoopActivated).not.toHaveBeenCalled();

    h.store.resume("1");
    h.store.pause("1", "controller_limit", "loop fire cap reached");
    const capped = await h.text("WorkflowRevise", {
      id: "1",
      expectedRevision: 2,
      expectedState: "investigate",
      expectedTransitionSeq: 0,
      reason: "Do not renew bounded work implicitly.",
      changes: [{ op: "reissue_state", stateId: "investigate", prompt: "Changed again." }],
    });
    expect(capped).toContain("controller fire cap is exhausted");
    expect(capped).toContain("Resuming does not renew the cap");
    expect(capped).not.toContain("Resume the workflow through /loop");
  });

  it("reissues active instructions, histories stale work, and wakes the fresh execution", async () => {
    await h.text("WorkflowCreate", { goal: "Fix the regression", definition: taskDefinition });
    const original = structuredClone(h.store.get("1")?.workflow?.activeExecution);
    h.triggerSystem.add.mockClear();
    h.triggerSystem.remove.mockClear();
    h.onDynamicLoopActivated.mockClear();

    const out = await h.text("WorkflowRevise", {
      id: "1",
      expectedRevision: 1,
      expectedState: "investigate",
      expectedTransitionSeq: 0,
      reason: "Wait for the upstream Brick change.",
      changes: [{
        op: "reissue_state",
        stateId: "investigate",
        prompt: "Wait for Brick; do not push.",
        task: { subject: "Wait for Brick", description: "Hold until the user confirms Brick is done." },
      }],
    });

    const entry = h.store.get("1");
    expect(out).toContain("Reissued active state: investigate");
    expect(out).toContain("Current execution replaced: investigate (investigate:0:r2)");
    expect(out).toContain("do not execute the superseded prompt");
    expect(entry?.workflow).toMatchObject({
      definitionRevision: 2,
      stateEnteredAt: expect.any(Number),
      definition: { states: { investigate: { prompt: "Wait for Brick; do not push." } } },
      activeExecution: {
        id: "investigate:0:r2",
        subject: "Wait for Brick",
        lease: original?.lease,
      },
      executionHistory: [{ id: "investigate:0", status: "cancelled", lease: undefined }],
    });
    expect(h.triggerSystem.remove).toHaveBeenCalledWith("1");
    expect(h.triggerSystem.add).toHaveBeenCalledWith(entry);
    expect(h.onDynamicLoopActivated).toHaveBeenCalledWith(entry);
  });

  it("renders authoritative paused state when reissue activation reaches its cap", async () => {
    await h.text("WorkflowCreate", { goal: "Fix the regression", definition: taskDefinition, maxFires: 1 });
    h.triggerSystem.remove.mockClear();
    h.onDynamicLoopActivated.mockClear();
    h.onDynamicLoopActivated.mockImplementationOnce((entry) => {
      h.store.fire(entry.id);
      h.store.pause(entry.id, "controller_limit", "loop fire cap reached");
    });

    const result = await h.result("WorkflowRevise", {
      id: "1",
      expectedRevision: 1,
      expectedState: "investigate",
      expectedTransitionSeq: 0,
      reason: "Replace stale instructions.",
      changes: [{ op: "reissue_state", stateId: "investigate", prompt: "Use the fresh instruction." }],
    });
    const out = result.content[0].text as string;

    expect(h.store.get("1")?.status).toBe("paused");
    expect(out).toContain("Controller limit reached during activation");
    expect(out).not.toContain("resume through /loop");
    expect(result.details).toMatchObject({ tone: "warning" });
    expect(h.triggerSystem.remove).toHaveBeenCalledTimes(2);
    expect(h.triggerSystem.remove).toHaveBeenLastCalledWith("1");
  });

  it("requires the current execution lease before revising and preserves it after claim", async () => {
    await h.text("WorkflowCreate", { goal: "Fix the regression", definition: taskDefinition });
    await h.text("WorkflowTransition", { id: "1", outcome: "found", evidence: "Investigation complete." });
    const revision = {
      id: "1",
      expectedRevision: 1,
      expectedState: "fix",
      expectedTransitionSeq: 1,
      reason: "Clarify future retry work.",
      changes: [{ op: "revise_state", stateId: "investigate", prompt: "Investigate revised requirements." }],
    };

    expect(await h.text("WorkflowRevise", revision)).toContain("Code: execution_unowned");
    await h.text("WorkflowClaim", { id: "1" });
    const lease = structuredClone(h.store.get("1")?.workflow?.activeExecution?.lease);
    expect(await h.text("WorkflowRevise", revision)).toContain("revision 1 → 2");
    expect(h.store.get("1")?.workflow?.activeExecution?.lease).toEqual(lease);
    expect(h.store.get("1")?.workflow).toMatchObject({
      definitionRevision: 2,
      definition: { states: { investigate: { prompt: "Investigate revised requirements." } } },
    });
  });

  it("does not expose claim tokens in transition schema or guidance", () => {
    const transition = h.toolMap.get("WorkflowTransition") as any;
    expect(transition.description).toContain("never accepts a claim token");
    expect(transition.promptGuidelines.join("\n")).toContain("claimId is invalid");
    expect(transition.parameters.properties.claimId).toBeUndefined();
  });

  it("guides a fix when a state declares no outcomes", async () => {
    const noOutcomes = JSON.stringify({
      version: 1,
      initialState: "stuck",
      states: {
        stuck: { prompt: "No exits declared." },
        done: { prompt: "Report.", terminal: "completed" },
      },
    });
    const out = await h.text("WorkflowCreate", { goal: "Fix the regression", definition: noOutcomes });
    expect(out).toContain("Plan gap: this state declares no outcomes");
    expect(out).toContain("Use WorkflowRevise with the displayed revision/state/sequence");
    expect(out).toContain("Persist it, then continue through its transition and claim when actionable");
    expect(out).toContain("do not stop or terminal-pause merely to report this gap");
    expect(out).not.toContain("Next: WorkflowTransition");
  });

  it("claims and renews the workflow execution lease through the tool", async () => {
    await h.text("WorkflowCreate", { goal: "Fix the regression", definition: taskDefinition });

    const out = await h.text("WorkflowClaim", { id: "1", leaseSeconds: 300 });
    const claimTool = h.toolMap.get("WorkflowClaim") as any;

    expect(out).toContain("lease active until");
    expect(h.store.get("1")?.workflow?.activeExecution?.lease?.ownerSessionId).toBe("test-session");
    expect(claimTool.renderCall).toBeTypeOf("function");
    expect(claimTool.description).toContain("Claim unowned workflow work");
    expect(claimTool.promptGuidelines.join("\n")).toContain("newly entered task phase");
  });

  it("rejects a claim for a missing workflow", async () => {
    expect(await h.text("WorkflowClaim", { id: "99" })).toContain("Loop #99 not found");
  });

  it("surfaces the failed outcome first among unavailable outcomes", () => {
    const entry = {
      id: "1",
      prompt: "Sort the blocked outcomes",
      trigger: { type: "dynamic" },
      status: "active",
      recurring: true,
      createdAt: 1,
      updatedAt: 1,
      expiresAt: 2,
      workflow: {
        definition: {
          version: 1,
          initialState: "investigate",
          states: {
            investigate: { prompt: "Investigate.", on: { to_aa: "aa_state", to_bb: "bb_state" } },
            aa_state: { prompt: "A.", maxAttempts: 1 },
            bb_state: { prompt: "B.", maxAttempts: 1 },
          },
        },
        currentState: "investigate",
        transitionSeq: 0,
        stateEnteredAt: 1,
        attemptsByState: { investigate: 1, aa_state: 1, bb_state: 1 },
        stateFireCounts: {},
      },
    } as any;

    const message = formatWorkflowSummary(entry, "heading", {
      code: "target_exhausted",
      outcome: "to_bb",
      targetState: "bb_state",
      maxAttempts: 1,
    });

    expect(message.indexOf("to_bb")).toBeLessThan(message.indexOf("to_aa"));
    expect(message).toContain("Route gap: all declared outcomes are unavailable");
    expect(message).toContain("use WorkflowRevise");
    expect(message).not.toContain("Next: WorkflowTransition");
  });

  it("routes a legacy unbounded self-loop rejection to revision without another transition", () => {
    const entry = {
      id: "1",
      prompt: "Await authority",
      trigger: { type: "dynamic" },
      status: "active",
      recurring: true,
      createdAt: 1,
      updatedAt: 1,
      expiresAt: 2,
      workflow: {
        definition: {
          version: 1,
          initialState: "wait",
          states: {
            wait: { prompt: "Wait.", on: { still_missing: "wait", received: "done" } },
            done: { prompt: "Done.", terminal: "completed" },
          },
        },
        definitionRevision: 1,
        revisionHistory: [],
        currentState: "wait",
        transitionSeq: 0,
        stateEnteredAt: 1,
        attemptsByState: { wait: 1 },
        stateFireCounts: {},
      },
    } as any;

    const message = formatWorkflowSummary(entry, "heading", {
      code: "unbounded_self_loop",
      outcome: "still_missing",
      targetState: "wait",
    });

    expect(message).toContain("Unsafe self-loop");
    expect(message).toContain("Use WorkflowRevise to add maxAttempts or redirect the outcome");
    expect(message).not.toContain("Next: WorkflowTransition");
  });

  it("does not let WorkflowTransition bypass a controller-limit self-loop pause", async () => {
    const boundedSelfLoop = JSON.stringify({
      version: 1,
      initialState: "wait",
      states: {
        wait: {
          prompt: "Wait for authority.",
          maxAttempts: 3,
          on: { still_missing: "wait", received: "done" },
        },
        done: { prompt: "Report.", terminal: "completed" },
      },
    });
    await h.text("WorkflowCreate", { goal: "Await authority", definition: boundedSelfLoop, maxFires: 1 });
    h.store.pause("1", "controller_limit", "loop fire cap reached");
    h.triggerSystem.add.mockClear();
    h.triggerSystem.remove.mockClear();
    h.onDynamicLoopActivated.mockClear();

    const out = await h.text("WorkflowTransition", {
      id: "1",
      outcome: "still_missing",
      evidence: "No authority change.",
    });

    expect(out).toContain("did not transition");
    expect(out).toContain("cannot bypass the controller limit");
    expect(out).toContain("Pause cause: controller_limit");
    expect(out).not.toContain("Next: WorkflowTransition");
    expect(h.store.get("1")).toMatchObject({
      status: "paused",
      workflow: { currentState: "wait", transitionSeq: 0, attemptsByState: { wait: 1 } },
    });
    expect(h.triggerSystem.add).not.toHaveBeenCalled();
    expect(h.triggerSystem.remove).not.toHaveBeenCalled();
    expect(h.onDynamicLoopActivated).not.toHaveBeenCalled();
  });

  it("renders authoritative paused state after synchronous activation", async () => {
    await h.text("WorkflowCreate", { goal: "Fix the regression", definition: taskDefinition });
    h.triggerSystem.remove.mockClear();
    h.onDynamicLoopActivated.mockClear();
    h.onDynamicLoopActivated.mockImplementationOnce((entry) => {
      h.store.pause(entry.id, "controller_limit", "loop fire cap reached");
    });

    const result = await h.result("WorkflowTransition", {
      id: "1",
      outcome: "found",
      evidence: "Reproduced locally.",
    });
    const out = result.content[0].text as string;

    expect(h.store.get("1")).toMatchObject({ status: "paused", workflow: { currentState: "fix", transitionSeq: 1 } });
    expect(out).toContain("Workflow #1 — paused");
    expect(out).toContain("Pause cause: controller_limit");
    expect(out).not.toContain("Next: WorkflowClaim");
    expect(out).not.toContain("Next: WorkflowTransition");
    expect(result.details).toMatchObject({
      tone: "warning",
      expanded: expect.arrayContaining([expect.stringContaining("Activity: paused")]),
    });
    expect(h.triggerSystem.remove).toHaveBeenCalledTimes(2);
    expect(h.triggerSystem.remove).toHaveBeenLastCalledWith("1");
  });

  it("queues the next wake after transitioning into an ordinary no-loop phase", async () => {
    await h.text("WorkflowCreate", { goal: "Fix the regression", definition: taskDefinition });
    h.onDynamicLoopActivated.mockClear();
    await h.text("WorkflowTransition", { id: "1", outcome: "found", evidence: "Reproduced locally." });
    expect(h.onDynamicLoopActivated).toHaveBeenCalledTimes(1);
    expect(h.onDynamicLoopActivated).toHaveBeenCalledWith(
      expect.objectContaining({ workflow: expect.objectContaining({ currentState: "fix" }) }),
    );
  });

  it("keeps scheduled non-immediate cadence destinations dormant until their schedule", async () => {
    const cadencedDefinition = JSON.stringify({
      version: 1,
      initialState: "investigate",
      states: {
        investigate: {
          prompt: "Find the cause.",
          task: { subject: "Investigate regression", description: "Find the root cause." },
          on: { found: "fix" },
        },
        fix: {
          prompt: "Fix it.",
          task: { subject: "Fix regression", description: "Apply the fix." },
          loop: { schedule: "0 0 * * *", maxFires: 2, startImmediately: false },
          on: { passing: "done" },
        },
        done: { prompt: "Report completion.", terminal: "completed" },
      },
    });
    await h.text("WorkflowCreate", { goal: "Fix the regression", definition: cadencedDefinition });
    h.onDynamicLoopActivated.mockClear();
    await h.text("WorkflowTransition", { id: "1", outcome: "found", evidence: "Reproduced locally." });
    expect(h.onDynamicLoopActivated).not.toHaveBeenCalled();
  });

  it("directs WorkflowClaim before work and transition when the destination lease is unowned", async () => {
    await h.text("WorkflowCreate", { goal: "Fix the regression", definition: taskDefinition });
    const out = await h.text("WorkflowTransition", { id: "1", outcome: "found", evidence: "Reproduced locally." });
    expect(out).toContain('Next: WorkflowClaim({ id: "1" })');
    expect(out).toContain("then complete the work and call WorkflowTransition");
    expect(out).not.toMatch(/^Next: WorkflowTransition\(/m);
  });

  it("rejects an undeclared outcome without changing the workflow", async () => {
    await h.text("WorkflowCreate", { goal: "Fix the regression", definition: taskDefinition });
    const out = await h.text("WorkflowTransition", { id: "1", outcome: "ship_it" });
    expect(out).toContain('Outcome "ship_it" is not allowed from state "investigate"');
    expect(h.store.get("1")?.workflow?.transitionSeq).toBe(0);
  });

  it("completes a task-bearing workflow without TaskStore cleanup", async () => {
    await h.text("WorkflowCreate", { goal: "Fix the regression", definition: taskDefinition });
    await h.text("WorkflowTransition", { id: "1", outcome: "found" });
    await h.text("WorkflowClaim", { id: "1" });
    const result = await h.result("WorkflowTransition", { id: "1", outcome: "passing" });
    expect(result.content[0].text).toContain("Workflow #1 completed and deleted");
    expect(result.details.summary).toContain("stopped");
    expect(result.details.expanded).toContainEqual(expect.stringContaining("Activity: stopped"));
    expect(result.details.expanded).toContainEqual(expect.stringContaining("Workflow age:"));
    expect(result.details.expanded).toContainEqual(expect.stringContaining("State age:"));
    expect(h.store.get("1")).toBeUndefined();
  });

  it("documents embedded task definitions and outcome evidence", async () => {
    const create = h.toolMap.get("WorkflowCreate") as any;
    expect(create.description).toContain("embedded atomically");
    expect(create.promptGuidelines.join("\n")).toContain("maxAttempts");
    const transition = h.toolMap.get("WorkflowTransition") as any;
    expect(transition.parameters.properties.evidence).toBeDefined();
    expect(transition.parameters.properties.claim).toBeDefined();
    expect(transition.parameters.properties.contextDigest).toBeUndefined();
    expect(transition.parameters.properties.claim.properties.context).toBeUndefined();
    expect(await h.text("WorkflowCreate", { goal: "Fix the regression", definition })).toContain("Definition revision: 1");
    expect(await h.text("LoopList", {})).toContain("Transition sequence: 0");
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
    expect(h.store.get("1")).toMatchObject({ status: "paused", pause: { kind: "administrative" } });
    expect(await h.text("LoopList", {})).toContain("[pause:administrative]");
  });

  it("delegates orchestration cancellation before deletion", async () => {
    h.store.delete("1");
    h.store.create({ type: "dynamic" }, "Parallel review", {
      recurring: true,
      orchestration: {
        owner: { sessionId: "s", runtimeId: "r", generation: 1 },
        definition: { goal: "Parallel review", work: [{ prompt: "Inspect" }] },
      },
    });

    expect(await h.text("LoopDelete", { id: "2", action: "delete" })).toBe("Orchestration #2 cancelled and deleted");
    expect(h.cancelOrchestration).toHaveBeenCalledWith("2", "delete");
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
