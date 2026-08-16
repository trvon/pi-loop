import { describe, expect, it } from "vitest";
import {
  createWorkflowRun,
  transitionWorkflowRun,
  validateWorkflowDefinition,
  type WorkflowDefinition,
} from "../src/workflow-reducer.js";

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
      currentState: "investigate",
      transitionSeq: 0,
      stateEnteredAt: 100,
      attemptsByState: { investigate: 1 },
      stateFireCounts: {},
    });
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
