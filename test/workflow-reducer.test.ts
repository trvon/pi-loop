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
  });
});
