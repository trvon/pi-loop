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
});
