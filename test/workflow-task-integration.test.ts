import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import extension from "../src/index.js";
import { resolveLoopStorePath, resolveTaskStorePath } from "../src/runtime/scope.js";
import { LoopStore } from "../src/store.js";
import { TaskStore } from "../src/task-store.js";
import { createMockPi } from "./helpers/mock-pi.js";

const RETRY_WORKFLOW = JSON.stringify({
  version: 1,
  initialState: "work",
  states: {
    work: {
      prompt: "Run one bounded attempt, then choose retry or done.",
      task: { subject: "Workflow attempt", description: "Complete this attempt, then use WorkflowTransition." },
      on: { retry: "work", done: "done" },
      maxAttempts: 3,
    },
    done: { prompt: "Report completion.", terminal: "completed" },
  },
});

const ORIGINAL_REQUIREMENTS_WORKFLOW = {
  version: 1,
  initialState: "investigate",
  states: {
    investigate: {
      prompt: "Determine the implementation constraints.",
      task: { subject: "Investigate requirements", description: "Identify the required implementation behavior." },
      on: { requirements_known: "implement" },
    },
    implement: {
      prompt: "Implement the original requirement.",
      task: { subject: "Implement workflow", description: "Automatically lease each destination phase." },
      on: { passing: "done" },
    },
    done: { prompt: "Report completion.", terminal: "completed" },
  },
};

const REVISED_REQUIREMENTS_WORKFLOW = {
  version: 1,
  initialState: "investigate",
  states: {
    investigate: {
      ...ORIGINAL_REQUIREMENTS_WORKFLOW.states.investigate,
      on: { requirements_known: "validate_handoff" },
    },
    validate_handoff: {
      prompt: "Validate the newly discovered cross-agent handoff requirement.",
      task: {
        subject: "Validate cross-agent handoff",
        description: "Prove a newly entered phase remains unowned and claimable by another runtime.",
      },
      on: { validated: "implement" },
    },
    implement: {
      prompt: "Implement the revised requirement.",
      task: {
        subject: "Implement workflow",
        description: "Leave each newly entered destination phase unowned until explicitly claimed.",
      },
      on: { passing: "done" },
    },
    done: ORIGINAL_REQUIREMENTS_WORKFLOW.states.done,
  },
};

const WORKFLOW_REVISION_CHANGES = [
  {
    op: "add_state",
    stateId: "validate_handoff",
    state: REVISED_REQUIREMENTS_WORKFLOW.states.validate_handoff,
  },
  {
    op: "redirect_transition",
    from: "investigate",
    outcome: "requirements_known",
    expectedTo: "implement",
    to: "validate_handoff",
  },
  {
    op: "revise_state",
    stateId: "implement",
    prompt: REVISED_REQUIREMENTS_WORKFLOW.states.implement.prompt,
    task: REVISED_REQUIREMENTS_WORKFLOW.states.implement.task,
  },
];

describe("embedded workflow execution integration", () => {
  let cwd: string;
  let originalCwd: string;

  beforeEach(() => {
    vi.useFakeTimers();
    originalCwd = process.cwd();
    cwd = mkdtempSync(join(tmpdir(), "pi-loop-workflow-integration-"));
    process.chdir(cwd);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(cwd, { recursive: true, force: true });
    vi.useRealTimers();
  });

  async function setup() {
    const harness = createMockPi();
    extension(harness.pi as any);
    const sessionId = "workflow-integration";
    const ctx = {
      ui: { setStatus: vi.fn(), setWidget: vi.fn() },
      hasPendingMessages: () => false,
      sessionManager: { getSessionId: () => sessionId },
    };
    for (const handler of harness.extensionHandlers.get("turn_start") ?? []) await handler(null, ctx);
    const taskPath = resolveTaskStorePath({ loopScope: "session", cwd }, sessionId)!;
    const loopPath = resolveLoopStorePath({ loopScope: "session", cwd }, sessionId)!;
    return { ...harness, ctx, taskPath, loopPath };
  }

  it("AUD-03: revising future work preserves the pending current execution wake at the new revision", async () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const h = await setup();
    try {
      await h.emitExtension("agent_start", null, h.ctx);
      await h.toolMap.get("WorkflowCreate")!.execute!("create", {
        goal: "Implement requirements",
        definition: JSON.stringify(ORIGINAL_REQUIREMENTS_WORKFLOW),
      });
      const before = new LoopStore(h.loopPath).get("1")!;
      expect(before.dynamic?.awaitingUpdate).toBe(true);
      expect(h.sentMessages).toEqual([]);
      const revised = await h.toolMap.get("WorkflowRevise")!.execute!("revise", {
        id: "1",
        expectedRevision: 1,
        expectedState: "investigate",
        expectedTransitionSeq: 0,
        reason: "Clarify future implementation.",
        changes: [{ op: "revise_state", stateId: "implement", prompt: "Implement the clarified requirement." }],
      });
      expect(revised.content[0].text).toContain("revision 1 → 2");
      expect(new LoopStore(h.loopPath).get("1")?.workflow?.activeExecution).toEqual(before.workflow?.activeExecution);
      await h.emitExtension("agent_end", null, h.ctx);
      await vi.advanceTimersByTimeAsync(30_000);

      expect(h.sentMessages).toHaveLength(1);
      expect(h.sentMessages[0]?.message.content).toContain("Determine the implementation constraints.");
      expect(h.sentMessages[0]?.message.content).toContain("Definition revision: 2");
      expect(new LoopStore(h.loopPath).get("1")?.workflow).toMatchObject({ currentState: "investigate", definitionRevision: 2 });
    } finally {
      await h.emitExtension("session_shutdown", null, h.ctx);
    }
  });

  it("AUD-06: the default budget permits an ordinary phase followed by one cadence fire and completion", async () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const h = await setup();
    try {
      await h.emitExtension("agent_start", null, h.ctx);
      const created = await h.toolMap.get("WorkflowCreate")!.execute!("create", {
        goal: "Prepare and poll",
        definition: JSON.stringify({
          version: 1,
          initialState: "prepare",
          states: {
            prepare: { prompt: "Prepare release.", on: { ready: "poll" } },
            poll: { prompt: "Poll release.", loop: { schedule: "* * * * *", maxFires: 1 }, on: { done: "done" } },
            done: { prompt: "Report success.", terminal: "completed" },
          },
        }),
      });
      expect(created.content[0].text).toContain("Workflow #1 created");
      expect(new LoopStore(h.loopPath).get("1")?.fireCount).toBe(1);
      const enteredPoll = await h.toolMap.get("WorkflowTransition")!.execute!("ready", { id: "1", outcome: "ready", evidence: "Preparation is complete." });
      expect(enteredPoll.content[0].text).toContain("prepare → poll");
      await h.emitExtension("agent_end", null, h.ctx);
      // The 90s heartbeat crosses the minute boundary plus deterministic #1 jitter.
      await vi.advanceTimersByTimeAsync(90_000);
      expect(new LoopStore(h.loopPath).get("1")?.fireCount).toBe(2);
      expect(h.sentMessages.filter((sent) => sent.message.content.includes("Poll release."))).toHaveLength(1);
      const completed = await h.toolMap.get("WorkflowTransition")!.execute!("done", { id: "1", outcome: "done", evidence: "Release is ready." });
      expect(completed.content[0].text).toContain("completed and deleted");
      expect(new LoopStore(h.loopPath).get("1")).toBeUndefined();
    } finally {
      await h.emitExtension("session_shutdown", null, h.ctx);
    }
  });

  it("creates task-bearing workflow work before task-provider detection and leaves TaskStore empty", async () => {
    const h = await setup();
    const created = await h.toolMap.get("WorkflowCreate")!.execute!("create", {
      goal: "Finish bounded workflow work",
      definition: RETRY_WORKFLOW,
    });

    expect(created.content[0].text).toContain("Active workflow work: Workflow attempt (work:0)");
    expect(new TaskStore(h.taskPath).list()).toEqual([]);
    expect(new LoopStore(h.loopPath).get("1")?.workflow).toMatchObject({
      currentState: "work",
      activeExecution: { id: "work:0", status: "active", lease: { ownerSessionId: "workflow-integration" } },
    });
  });

  it("durably inserts discovered work and revises future requirements without external tasks", async () => {
    const h = await setup();
    await h.toolMap.get("WorkflowCreate")!.execute!("create", {
      goal: "Implement a collaborative workflow",
      definition: JSON.stringify(ORIGINAL_REQUIREMENTS_WORKFLOW),
    });

    const before = new LoopStore(h.loopPath).get("1")!;
    const initialExecution = before.workflow?.activeExecution;
    const revise = h.toolMap.get("WorkflowRevise");
    expect(revise, "running workflows need a durable revision surface").toBeDefined();

    const reason = "Investigation found that destination work must remain claimable by another runtime.";
    const revised = await revise!.execute!("revise", {
      id: "1",
      expectedRevision: 1,
      expectedState: "investigate",
      expectedTransitionSeq: 0,
      reason,
      changes: WORKFLOW_REVISION_CHANGES,
    });
    expect(revised.content[0].text).toContain("revision 1 → 2");

    const afterRevision = new LoopStore(h.loopPath).get("1")!;
    expect(afterRevision.workflow).toMatchObject({
      definitionRevision: 2,
      definition: REVISED_REQUIREMENTS_WORKFLOW,
      currentState: "investigate",
      transitionSeq: 0,
      activeExecution: initialExecution,
      revisionHistory: [{
        revision: 1,
        definition: ORIGINAL_REQUIREMENTS_WORKFLOW,
        reason,
        supersededAt: expect.any(Number),
        supersededBy: { sessionId: "workflow-integration", runtimeId: expect.any(String) },
        changes: WORKFLOW_REVISION_CHANGES,
      }],
    });
    expect(afterRevision.workflow?.activeExecution).toEqual(initialExecution);
    expect(new TaskStore(h.taskPath).list()).toEqual([]);

    await h.toolMap.get("WorkflowTransition")!.execute!("discovered", {
      id: "1",
      outcome: "requirements_known",
      evidence: "The handoff requirement is now part of revision 2.",
    });
    expect(new LoopStore(h.loopPath).get("1")?.workflow).toMatchObject({
      currentState: "validate_handoff",
      activeExecution: {
        subject: "Validate cross-agent handoff",
        description: "Prove a newly entered phase remains unowned and claimable by another runtime.",
      },
    });

    const staleRevision = await revise!.execute!("stale-revise", {
      id: "1",
      expectedRevision: 1,
      expectedState: "investigate",
      expectedTransitionSeq: 0,
      reason: "Overwrite revision 2 from stale state.",
      changes: [{
        op: "revise_state",
        stateId: "implement",
        prompt: "Apply stale requirements.",
      }],
    });
    expect(staleRevision.content[0].text).toContain("expected revision 1");
    expect(new LoopStore(h.loopPath).get("1")?.workflow).toMatchObject({
      definitionRevision: 2,
      currentState: "validate_handoff",
      definition: REVISED_REQUIREMENTS_WORKFLOW,
    });
    expect(new TaskStore(h.taskPath).list()).toEqual([]);
  });

  it("self-loops through durable embedded attempts and completes without task records", async () => {
    const h = await setup();
    await h.toolMap.get("WorkflowCreate")!.execute!("create", {
      goal: "Finish bounded workflow work",
      definition: RETRY_WORKFLOW,
      maxFires: 10,
    });

    const retried = await h.toolMap.get("WorkflowTransition")!.execute!("retry", {
      id: "1",
      outcome: "retry",
      evidence: "Attempt one exposed another case.",
    });
    expect(retried.content[0].text).toContain("work → work");
    expect(new LoopStore(h.loopPath).get("1")?.workflow).toMatchObject({
      transitionSeq: 1,
      attemptsByState: { work: 2 },
      activeExecution: { id: "work:1", status: "active" },
      executionHistory: [{ id: "work:0", status: "completed" }],
    });
    expect(new TaskStore(h.taskPath).list()).toEqual([]);

    const claimed = await h.toolMap.get("WorkflowClaim")!.execute!("claim", { id: "1" });
    expect(claimed.content[0].text).toContain("lease active until");
    expect(new LoopStore(h.loopPath).get("1")?.workflow?.activeExecution?.lease).toMatchObject({
      ownerSessionId: "workflow-integration",
    });

    const completed = await h.toolMap.get("WorkflowTransition")!.execute!("done", {
      id: "1",
      outcome: "done",
      evidence: "Attempt two satisfies the done criteria.",
    });
    expect(completed.content[0].text).toContain("completed and deleted");
    expect(new LoopStore(h.loopPath).list()).toEqual([]);
    expect(new TaskStore(h.taskPath).list()).toEqual([]);
  });
});
