import { describe, expect, it } from "vitest";
import type { WorkflowDefinition, WorkflowRevisionChange } from "../src/types.js";
import { validateWorkflowDefinition } from "../src/workflow-definition.js";
import { createWorkflowRun, getWorkflowOutcomeAvailability, transitionWorkflowRun } from "../src/workflow-reducer.js";
import { MAX_WORKFLOW_REVISIONS, reviseWorkflowRun, validatePersistedWorkflowRevision } from "../src/workflow-revision.js";

const definition: WorkflowDefinition = {
  version: 1,
  initialState: "investigate",
  states: {
    investigate: {
      prompt: "Find and verify the root cause.",
      on: { root_cause_found: "fix", blocked: "blocked" },
    },
    fix: {
      prompt: "Implement and validate the fix.",
      on: { tests_pass: "done", regression_found: "investigate" },
      maxAttempts: 2,
    },
    done: { prompt: "Report completion.", terminal: "completed" },
    blocked: { prompt: "Report the blocker.", terminal: "paused" },
  },
};

describe("workflow reducer", () => {
  it("creates a run at its named initial state", () => {
    expect(createWorkflowRun(definition, 100)).toEqual({
      definition,
      definitionRevision: 1,
      revisionHistory: [],
      currentState: "investigate",
      transitionSeq: 0,
      stateEnteredAt: 100,
      attemptsByState: { investigate: 1 },
      stateFireCounts: {},
      activeExecution: undefined,
    });
  });

  it.each([
    ["disconnected work", "orphan", {
      version: 1,
      initialState: "start",
      states: {
        start: { prompt: "Start", on: { done: "done" } },
        orphan: { prompt: "Never reached", on: { done: "done" } },
        done: { prompt: "Done", terminal: "completed" },
      },
    }],
    ["disconnected terminal", "orphanDone", {
      version: 1,
      initialState: "start",
      states: {
        start: { prompt: "Start", on: { loop: "start" }, maxAttempts: 2 },
        orphanDone: { prompt: "Never reached", terminal: "completed" },
      },
    }],
    ["disconnected cycle", "a", {
      version: 1,
      initialState: "start",
      states: {
        start: { prompt: "Start", on: { done: "done" } },
        a: { prompt: "A", on: { next: "b" } },
        b: { prompt: "B", on: { next: "a" } },
        done: { prompt: "Done", terminal: "completed" },
      },
    }],
  ] as const)("rejects %s in an initial workflow definition", (_name, stateId, candidate) => {
    expect(validateWorkflowDefinition(candidate as WorkflowDefinition))
      .toBe(`Workflow state "${stateId}" is not reachable from initial state "start"`);
  });

  it("accepts a cycle when every state remains reachable from the initial state", () => {
    expect(validateWorkflowDefinition({
      version: 1,
      initialState: "start",
      states: {
        start: { prompt: "Start", on: { next: "a" } },
        a: { prompt: "A", on: { next: "b" } },
        b: { prompt: "B", on: { retry: "a", done: "complete" } },
        complete: { prompt: "Done", terminal: "completed" },
      },
    })).toBeUndefined();
  });

  it("embeds and leases initial state work in the workflow aggregate", () => {
    const taskDefinition: WorkflowDefinition = {
      version: 1,
      initialState: "work",
      states: {
        work: {
          prompt: "Do the work.",
          task: { subject: "Work", description: "Complete the bounded work." },
          on: { done: "complete" },
        },
        complete: { prompt: "Report completion.", terminal: "completed" },
      },
    };

    expect(createWorkflowRun(taskDefinition, 100, { sessionId: "session-a", runtimeId: "runtime-a" }))
      .toMatchObject({
        activeExecution: {
          id: "work:0",
          stateId: "work",
          transitionSeq: 0,
          subject: "Work",
          description: "Complete the bounded work.",
          status: "active",
          lease: { ownerSessionId: "session-a", ownerRuntimeId: "runtime-a", expiresAt: 100 + 30 * 60 * 1000 },
        },
      });
  });

  it("moves only along a declared outcome and records evidence", () => {
    const run = createWorkflowRun(definition, 100);
    const result = transitionWorkflowRun(run, { outcome: "root_cause_found", evidence: "Null config reaches parser." }, 200);

    expect(result).toEqual({
      applied: true,
      run: expect.objectContaining({
        currentState: "fix",
        transitionSeq: 1,
        stateEnteredAt: 200,
        attemptsByState: { investigate: 1, fix: 1 },
        lastTransition: {
          from: "investigate",
          to: "fix",
          outcome: "root_cause_found",
          evidence: "Null config reaches parser.",
          at: 200,
          sequence: 1,
        },
      }),
    });
  });

  it("settles source work and activates unowned destination work atomically", () => {
    const taskDefinition: WorkflowDefinition = {
      version: 1,
      initialState: "investigate",
      states: {
        investigate: {
          prompt: "Investigate.",
          task: { subject: "Investigate", description: "Find the cause." },
          on: { found: "fix" },
        },
        fix: {
          prompt: "Fix it.",
          task: { subject: "Fix", description: "Implement the repair." },
          on: { done: "complete" },
        },
        complete: { prompt: "Report.", terminal: "completed" },
      },
    };
    const actor = { sessionId: "session-a", runtimeId: "runtime-a" };
    const run = createWorkflowRun(taskDefinition, 100, actor);

    const result = transitionWorkflowRun(run, { outcome: "found", actor }, 200);

    expect(result).toMatchObject({
      applied: true,
      run: {
        currentState: "fix",
        activeExecution: {
          id: "fix:1",
          status: "active",
        },
        executionHistory: [{ id: "investigate:0", status: "completed", settledAt: 200 }],
      },
    });
    if (!result.applied) throw new Error("expected transition to apply");
    expect(result.run.activeExecution?.lease).toBeUndefined();
  });

  it("rejects a workflow transition from a different live lease owner", () => {
    const taskDefinition: WorkflowDefinition = {
      version: 1,
      initialState: "work",
      states: {
        work: { prompt: "Work.", task: { subject: "Work", description: "Do it." }, on: { done: "complete" } },
        complete: { prompt: "Report.", terminal: "completed" },
      },
    };
    const run = createWorkflowRun(taskDefinition, 100, { sessionId: "session-a", runtimeId: "runtime-a" });

    expect(transitionWorkflowRun(run, {
      outcome: "done",
      actor: { sessionId: "session-b", runtimeId: "runtime-b" },
    }, 200)).toEqual({ applied: false, error: "Workflow execution is leased to another active runtime" });
  });

  it("fails closed for an unowned execution until a runtime claims it", () => {
    const taskDefinition: WorkflowDefinition = {
      version: 1,
      initialState: "work",
      states: {
        work: { prompt: "Work.", task: { subject: "Work", description: "Do it." }, on: { done: "complete" } },
        complete: { prompt: "Report.", terminal: "completed" },
      },
    };
    const run = createWorkflowRun(taskDefinition, 100);

    expect(transitionWorkflowRun(run, {
      outcome: "done",
      actor: { sessionId: "session-b", runtimeId: "runtime-b" },
    }, 200)).toEqual({ applied: false, error: "Workflow execution is unowned; claim it before transitioning" });
  });

  it("requires a claim after the execution lease expires", () => {
    const taskDefinition: WorkflowDefinition = {
      version: 1,
      initialState: "work",
      states: {
        work: { prompt: "Work.", task: { subject: "Work", description: "Do it." }, on: { done: "complete" } },
        complete: { prompt: "Report.", terminal: "completed" },
      },
    };
    const run = createWorkflowRun(taskDefinition, 100, { sessionId: "session-a", runtimeId: "runtime-a" });
    const expired = {
      ...run,
      activeExecution: {
        ...run.activeExecution!,
        lease: { ...run.activeExecution!.lease!, expiresAt: 150 },
      },
    };

    expect(transitionWorkflowRun(expired, {
      outcome: "done",
      actor: { sessionId: "session-a", runtimeId: "runtime-a" },
    }, 200)).toEqual({ applied: false, error: "Workflow execution lease expired; claim it before transitioning" });
  });

  it("requires an active session runtime to transition task work", () => {
    const taskDefinition: WorkflowDefinition = {
      version: 1,
      initialState: "work",
      states: {
        work: { prompt: "Work.", task: { subject: "Work", description: "Do it." }, on: { done: "complete" } },
        complete: { prompt: "Report.", terminal: "completed" },
      },
    };
    const run = createWorkflowRun(taskDefinition, 100, { sessionId: "session-a", runtimeId: "runtime-a" });

    expect(transitionWorkflowRun(run, { outcome: "done" }, 150)).toEqual({
      applied: false,
      error: "Workflow transition requires an active session runtime",
    });
  });

  it("rejects undeclared outcomes without changing the run", () => {
    const run = createWorkflowRun(definition, 100);
    expect(transitionWorkflowRun(run, { outcome: "ship_it" }, 200)).toEqual({
      applied: false,
      error: 'Outcome "ship_it" is not allowed from state "investigate"',
    });
  });

  it("rejects unbounded self-loops in new and legacy workflow definitions", () => {
    const unbounded: WorkflowDefinition = {
      version: 1,
      initialState: "wait",
      states: {
        wait: { prompt: "Wait for authority.", on: { still_missing: "wait", received: "done" } },
        done: { prompt: "Report.", terminal: "completed" },
      },
    };

    expect(validateWorkflowDefinition(unbounded)).toBe(
      'State "wait" self-loop "still_missing" requires maxAttempts',
    );
    expect(validatePersistedWorkflowRevision({
      revision: 1,
      definition: unbounded,
      reason: "Legacy definition",
      supersededAt: 100,
      supersededBy: { sessionId: "legacy-session", runtimeId: "legacy-runtime" },
      changes: [{ op: "revise_state", stateId: "done", prompt: "Report." }],
    }, 1)).toBeUndefined();
    const run = createWorkflowRun(unbounded, 100);
    expect(getWorkflowOutcomeAvailability(run)).toEqual({
      available: ["received"],
      unavailable: [{ outcome: "still_missing", targetState: "wait", reason: "unbounded_self_loop" }],
    });
    expect(transitionWorkflowRun(run, { outcome: "still_missing", evidence: "No authority change." }, 200)).toEqual({
      applied: false,
      error: 'State "wait" self-loop "still_missing" is unbounded; revise it with maxAttempts before retrying',
      failure: {
        code: "unbounded_self_loop",
        outcome: "still_missing",
        targetState: "wait",
      },
    });
    expect(run).toMatchObject({ currentState: "wait", transitionSeq: 0, attemptsByState: { wait: 1 } });
  });

  it("returns structured target exhaustion without hiding unrelated outcomes", () => {
    const limited: WorkflowDefinition = {
      version: 1,
      initialState: "investigate",
      states: {
        investigate: {
          prompt: "Find the cause.",
          on: { found: "fix" },
          maxAttempts: 1,
        },
        fix: {
          prompt: "Fix it.",
          on: { regression_found: "investigate", tests_pass: "done" },
        },
        done: { prompt: "Report.", terminal: "completed" },
      },
    };
    const run = createWorkflowRun(limited, 100);
    const fixed = transitionWorkflowRun(run, { outcome: "found" }, 200);
    if (!fixed.applied) throw new Error("expected transition to apply");

    expect(
      transitionWorkflowRun(fixed.run, { outcome: "regression_found" }, 300),
    ).toEqual({
      applied: false,
      error: 'State "investigate" has exhausted its 1 attempt limit',
      failure: {
        code: "target_exhausted",
        outcome: "regression_found",
        targetState: "investigate",
        maxAttempts: 1,
      },
    });
  });

  it("reports terminal workflow states", () => {
    const run = createWorkflowRun(definition, 100);
    const fixed = transitionWorkflowRun(run, { outcome: "root_cause_found" }, 200);
    if (!fixed.applied) throw new Error("expected transition to apply");
    const completed = transitionWorkflowRun(fixed.run, { outcome: "tests_pass" }, 300);

    expect(completed).toEqual(expect.objectContaining({
      applied: true,
      terminal: "completed",
      run: expect.objectContaining({ currentState: "done", transitionSeq: 2 }),
    }));
  });

  it("rejects definitions with an unknown initial or transition target", () => {
    expect(validateWorkflowDefinition({ ...definition, initialState: "missing" })).toBe('Initial state "missing" is not defined');
    expect(validateWorkflowDefinition({
      ...definition,
      states: { ...definition.states, done: { ...definition.states.done, terminal: true } },
    } as unknown as WorkflowDefinition)).toBe('State "done" terminal must be "completed" or "paused"');
    expect(validateWorkflowDefinition({
      ...definition,
      states: {
        ...definition.states,
        investigate: { ...definition.states.investigate, on: { continue: "missing" } },
      },
    })).toBe('Transition "investigate.continue" targets unknown state "missing"');
  });

  it("atomically revises future work and preserves the active execution", () => {
    const actor = { sessionId: "session-a", runtimeId: "runtime-a" };
    const taskDefinition: WorkflowDefinition = {
      version: 1,
      initialState: "investigate",
      states: {
        investigate: {
          prompt: "Investigate.",
          task: { subject: "Investigate", description: "Find requirements." },
          on: { ready: "implement" },
        },
        implement: {
          prompt: "Implement.",
          task: { subject: "Implement", description: "Apply old requirements." },
          on: { done: "complete" },
        },
        complete: { prompt: "Report.", terminal: "completed" },
      },
    };
    const run = createWorkflowRun(taskDefinition, 100, actor);
    run.stateFireCounts.investigate = 2;
    const activeExecution = structuredClone(run.activeExecution);
    const changes = [
      {
        op: "add_state" as const,
        stateId: "validate",
        state: {
          prompt: "Validate.",
          task: { subject: "Validate", description: "Check the discovered requirement." },
          on: { validated: "implement" },
        },
      },
      {
        op: "redirect_transition" as const,
        from: "investigate",
        outcome: "ready",
        expectedTo: "implement",
        to: "validate",
      },
      {
        op: "revise_state" as const,
        stateId: "implement",
        prompt: "Implement revised requirements.",
        task: { subject: "Implement", description: "Apply discovered requirements." },
      },
    ];

    const result = reviseWorkflowRun(run, {
      expectedRevision: 1,
      expectedState: "investigate",
      expectedTransitionSeq: 0,
      reason: "Investigation discovered validation work.",
      changes,
      actor,
    }, 200);
    if (!result.applied) throw new Error(result.error);

    expect(result.run).toMatchObject({
      definitionRevision: 2,
      currentState: "investigate",
      transitionSeq: 0,
      stateEnteredAt: 100,
      stateFireCounts: { investigate: 2 },
      revisionHistory: [{
        revision: 1,
        definition: taskDefinition,
        reason: "Investigation discovered validation work.",
        supersededAt: 200,
        supersededBy: actor,
        changes,
      }],
    });
    expect(result.run.activeExecution).toEqual(activeExecution);
    expect(result.run.definition.states.investigate.on?.ready).toBe("validate");
    expect(result.run.definition.states.validate.on?.validated).toBe("implement");
    expect(result.run.definition.states.implement.task?.description).toBe("Apply discovered requirements.");

    const addedState = changes[0];
    if (addedState?.op !== "add_state") throw new Error("expected add_state change");
    addedState.state.prompt = "Mutated input";
    taskDefinition.states.implement.prompt = "Mutated original";
    expect(result.run.revisionHistory[0].changes[0]).toMatchObject({ state: { prompt: "Validate." } });
    expect(result.run.revisionHistory[0].definition.states.implement.prompt).toBe("Implement.");
  });

  it("atomically reissues the active state with fresh instructions under the current lease", () => {
    const actor = { sessionId: "session-a", runtimeId: "runtime-a" };
    const taskDefinition: WorkflowDefinition = {
      version: 1,
      initialState: "open-pr",
      states: {
        "open-pr": {
          prompt: "Push now and open the PR.",
          task: { subject: "Open PR", description: "Push now and open the PR." },
          on: { opened: "done" },
        },
        done: { prompt: "Report.", terminal: "completed" },
      },
    };
    const run = createWorkflowRun(taskDefinition, 100, actor);
    run.stateFireCounts["open-pr"] = 3;
    const before = structuredClone(run);
    const originalExecution = structuredClone(run.activeExecution);
    const originalLease = structuredClone(run.activeExecution?.lease);
    const changes: WorkflowRevisionChange[] = [{
      op: "reissue_state",
      stateId: "open-pr",
      prompt: "Wait until the Brick work is done; do not push yet.",
      task: { subject: "Wait for Brick", description: "Hold the branch until the user confirms Brick is done." },
    }];

    const result = reviseWorkflowRun(run, {
      expectedRevision: 1,
      expectedState: "open-pr",
      expectedTransitionSeq: 0,
      reason: "The user deferred the push until Brick work finishes.",
      changes,
      actor,
    }, 200);
    if (!result.applied) throw new Error(result.error);

    expect(result.run).toMatchObject({
      definitionRevision: 2,
      currentState: "open-pr",
      transitionSeq: 0,
      stateEnteredAt: 200,
      stateFireCounts: { "open-pr": 0 },
      definition: {
        states: {
          "open-pr": {
            prompt: "Wait until the Brick work is done; do not push yet.",
            task: { subject: "Wait for Brick", description: "Hold the branch until the user confirms Brick is done." },
          },
        },
      },
      activeExecution: {
        id: "open-pr:0:r2",
        stateId: "open-pr",
        transitionSeq: 0,
        status: "active",
        subject: "Wait for Brick",
        description: "Hold the branch until the user confirms Brick is done.",
        lease: originalLease,
      },
      executionHistory: [{
        ...originalExecution,
        status: "cancelled",
        updatedAt: 200,
        settledAt: 200,
        evidence: "Reissued: The user deferred the push until Brick work finishes.",
        lease: undefined,
      }],
    });
    expect(result.run.revisionHistory[0]).toMatchObject({
      revision: 1,
      definition: taskDefinition,
      changes,
    });
    expect(run).toEqual(before);
  });

  it("can reissue taskless current instructions into fresh unowned work", () => {
    const actor = { sessionId: "session-a", runtimeId: "runtime-a" };
    const taskless: WorkflowDefinition = {
      version: 1,
      initialState: "wait",
      states: {
        wait: { prompt: "Wait.", on: { ready: "done" } },
        done: { prompt: "Done.", terminal: "completed" },
      },
    };
    const run = createWorkflowRun(taskless, 100);
    const result = reviseWorkflowRun(run, {
      expectedRevision: 1,
      expectedState: "wait",
      expectedTransitionSeq: 0,
      reason: "New work is now actionable.",
      changes: [{
        op: "reissue_state",
        stateId: "wait",
        prompt: "Implement the now-ready change.",
        task: { subject: "Implement", description: "Apply the ready change." },
      }],
      actor,
    }, 200);
    if (!result.applied) throw new Error(result.error);

    expect(result.summary.reissuedStates).toEqual(["wait"]);
    expect(result.run).toMatchObject({
      stateEnteredAt: 200,
      transitionSeq: 0,
      activeExecution: {
        id: "wait:0:r2",
        subject: "Implement",
        lease: undefined,
      },
    });
    expect(result.run.executionHistory).toBeUndefined();
  });

  it("validates reissue limits against reset fires and the unchanged current attempt", () => {
    const actor = { sessionId: "session-a", runtimeId: "runtime-a" };
    const limited: WorkflowDefinition = {
      version: 1,
      initialState: "wait",
      states: {
        wait: {
          prompt: "Wait.",
          loop: { schedule: "*/5 * * * *", maxFires: 10 },
          on: { done: "complete" },
          maxAttempts: 1,
        },
        complete: { prompt: "Complete.", terminal: "completed" },
      },
    };
    const run = createWorkflowRun(limited, 100);
    run.stateFireCounts.wait = 5;
    const accepted = reviseWorkflowRun(run, {
      expectedRevision: 1,
      expectedState: "wait",
      expectedTransitionSeq: 0,
      reason: "Restart the current instruction window.",
      changes: [{
        op: "reissue_state",
        stateId: "wait",
        prompt: "Wait for new evidence.",
        maxAttempts: 1,
        loop: { schedule: "*/10 * * * *", maxFires: 3 },
      }],
      actor,
    }, 200);
    expect(accepted).toMatchObject({
      applied: true,
      run: { attemptsByState: { wait: 1 }, stateFireCounts: { wait: 0 } },
    });

    run.attemptsByState.wait = 2;
    expect(reviseWorkflowRun(run, {
      expectedRevision: 1,
      expectedState: "wait",
      expectedTransitionSeq: 0,
      reason: "Do not erase attempt history.",
      changes: [{ op: "reissue_state", stateId: "wait", prompt: "Changed.", maxAttempts: 1 }],
      actor,
    }, 200)).toMatchObject({ applied: false, failure: { code: "invalid_patch" } });
  });

  it("rejects reissuing a non-current state or combining two changes to active work", () => {
    const actor = { sessionId: "session-a", runtimeId: "runtime-a" };
    const taskDefinition: WorkflowDefinition = {
      version: 1,
      initialState: "work",
      states: {
        work: { prompt: "Work.", task: { subject: "Work", description: "Do it." }, on: { done: "future" } },
        future: { prompt: "Future.", on: { done: "complete" } },
        complete: { prompt: "Complete.", terminal: "completed" },
      },
    };
    const run = createWorkflowRun(taskDefinition, 100, actor);
    const before = structuredClone(run);
    const base = {
      expectedRevision: 1,
      expectedState: "work",
      expectedTransitionSeq: 0,
      reason: "Replace instructions.",
      actor,
    };

    expect(reviseWorkflowRun(run, {
      ...base,
      changes: [{ op: "reissue_state", stateId: "future", prompt: "Changed." }],
    }, 200)).toMatchObject({ applied: false, failure: { code: "state_conflict" } });
    expect(reviseWorkflowRun(run, {
      ...base,
      changes: [
        { op: "reissue_state", stateId: "work", prompt: "Changed." },
        { op: "revise_state", stateId: "work", prompt: "Changed twice." },
      ],
    }, 200)).toMatchObject({ applied: false, failure: { code: "invalid_patch" } });
    expect(run).toEqual(before);
  });

  it("rejects stale, unauthorized, destructive, and disconnected revisions without mutation", () => {
    const owner = { sessionId: "session-a", runtimeId: "runtime-a" };
    const foreign = { sessionId: "session-b", runtimeId: "runtime-b" };
    const taskDefinition: WorkflowDefinition = {
      version: 1,
      initialState: "work",
      states: {
        work: {
          prompt: "Work.",
          task: { subject: "Work", description: "Do it." },
          on: { done: "complete" },
        },
        future: { prompt: "Future.", on: { done: "complete" } },
        complete: { prompt: "Report.", terminal: "completed" },
      },
    };
    const run = createWorkflowRun(taskDefinition, 100, owner);
    const before = structuredClone(run);
    const base = {
      expectedRevision: 1,
      expectedState: "work",
      expectedTransitionSeq: 0,
      reason: "New information.",
      actor: owner,
    };

    expect(reviseWorkflowRun(run, { ...base, expectedRevision: 2, changes: [{ op: "revise_state", stateId: "future", prompt: "Changed." }] }, 200))
      .toMatchObject({ applied: false, failure: { code: "revision_conflict" } });
    expect(reviseWorkflowRun(run, { ...base, expectedState: "future", changes: [{ op: "revise_state", stateId: "future", prompt: "Changed." }] }, 200))
      .toMatchObject({ applied: false, failure: { code: "run_conflict" } });
    expect(reviseWorkflowRun(run, { ...base, actor: foreign, changes: [{ op: "revise_state", stateId: "future", prompt: "Changed." }] }, 200))
      .toMatchObject({ applied: false, failure: { code: "lease_owned_elsewhere" } });
    expect(reviseWorkflowRun(run, { ...base, changes: [{ op: "revise_state", stateId: "work", prompt: "Changed." }] }, 200))
      .toMatchObject({ applied: false, failure: { code: "current_state_immutable" } });
    expect(reviseWorkflowRun(run, {
      ...base,
      changes: [
        { op: "add_state", stateId: "detour", state: { prompt: "Detour.", on: { loop: "detour" } } },
        { op: "redirect_transition", from: "work", outcome: "done", expectedTo: "complete", to: "detour" },
      ],
    }, 200)).toMatchObject({ applied: false, failure: { code: "graph_invalid" } });
    expect(run).toEqual(before);
  });

  it("rejects exhausted future limits, duplicate changes, and revision overflow", () => {
    const run = createWorkflowRun(definition, 100);
    run.attemptsByState.fix = 2;
    const base = {
      expectedRevision: 1,
      expectedState: "investigate",
      expectedTransitionSeq: 0,
      reason: "Revise future work.",
      actor: { sessionId: "session-a", runtimeId: "runtime-a" },
    };
    expect(reviseWorkflowRun(run, {
      ...base,
      changes: [{ op: "revise_state", stateId: "fix", maxAttempts: 2 }],
    }, 200)).toMatchObject({ applied: false, failure: { code: "invalid_patch" } });
    expect(reviseWorkflowRun(run, {
      ...base,
      changes: [
        { op: "revise_state", stateId: "fix", prompt: "One." },
        { op: "revise_state", stateId: "fix", prompt: "Two." },
      ],
    }, 200)).toMatchObject({ applied: false, failure: { code: "invalid_patch" } });

    run.definitionRevision = MAX_WORKFLOW_REVISIONS;
    run.revisionHistory = Array.from({ length: MAX_WORKFLOW_REVISIONS - 1 }, (_, index) => ({
      revision: index + 1,
      definition,
      reason: `revision ${index + 1}`,
      supersededAt: index + 1,
      supersededBy: base.actor,
      changes: [],
    }));
    expect(reviseWorkflowRun(run, {
      ...base,
      expectedRevision: MAX_WORKFLOW_REVISIONS,
      changes: [{ op: "revise_state", stateId: "fix", prompt: "Too late." }],
    }, 200)).toMatchObject({ applied: false, failure: { code: "revision_limit_reached" } });
  });

  it("rejects unsafe keys, malformed task work, and oversized definitions", () => {
    expect(validateWorkflowDefinition({
      version: 1,
      initialState: "constructor",
      states: { constructor: { prompt: "Unsafe." } },
    })).toContain("cannot be reserved");
    expect(validateWorkflowDefinition({
      version: 1,
      initialState: "work",
      states: {
        work: { prompt: "Work.", task: { subject: "", description: "Do it." } },
      },
    })).toBe('State "work" task requires a subject');
    expect(validateWorkflowDefinition({
      version: 1,
      initialState: "work",
      states: { work: { prompt: "x".repeat(66_000) } },
    })).toContain("exceeds 65536 UTF-8 bytes");
  });

  it("validates optional cron loop policies only on nonterminal states", () => {
    const scheduled: WorkflowDefinition = {
      version: 1,
      initialState: "collect",
      states: {
        collect: {
          prompt: "Collect input.",
          loop: { schedule: "0 7 * * *", maxFires: 4 },
          on: { ready: "done" },
        },
        done: { prompt: "Publish output.", terminal: "completed" },
      },
    };

    expect(validateWorkflowDefinition(scheduled)).toBeUndefined();
    expect(validateWorkflowDefinition({
      ...scheduled,
      states: {
        ...scheduled.states,
        collect: { ...scheduled.states.collect, loop: { schedule: "not cron" } },
      },
    })).toBe('State "collect" loop schedule must be a valid 5-field cron expression');
    expect(validateWorkflowDefinition({
      ...scheduled,
      states: {
        ...scheduled.states,
        done: { ...scheduled.states.done, loop: { schedule: "0 7 * * *" } },
      },
    })).toBe('Terminal state "done" cannot declare a loop policy');

    const nullLoop = {
      ...scheduled,
      states: {
        ...scheduled.states,
        collect: { ...scheduled.states.collect, loop: null },
      },
    } as unknown as WorkflowDefinition;
    expect(validateWorkflowDefinition(nullLoop)).toBe('State "collect" loop must be an object');

    const nonStringSchedule = {
      ...scheduled,
      states: {
        ...scheduled.states,
        collect: { ...scheduled.states.collect, loop: { schedule: 7 } },
      },
    } as unknown as WorkflowDefinition;
    expect(validateWorkflowDefinition(nonStringSchedule)).toBe(
      'State "collect" loop schedule must be a valid 5-field cron expression',
    );
  });
});
