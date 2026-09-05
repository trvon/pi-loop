import { describe, expect, it } from "vitest";
import { LoopStore } from "../src/store.js";
import type { WorkflowDefinition } from "../src/types.js";
import { diagnoseWorkflowGraph, formatWorkflowGraphWarnings } from "../src/workflow-graph.js";

function run(states: WorkflowDefinition["states"], initialState = "a") {
  return new LoopStore().create({ type: "dynamic" }, "inspect graph", {
    recurring: true, workflow: { version: 1, initialState, states },
  }).workflow!;
}

describe("workflow convergence diagnostics", () => {
  it("warns about closed multi-state cycles without rejecting the workflow", () => {
    const workflow = run({ a: { prompt: "A", on: { next: "b" } }, b: { prompt: "B", on: { back: "a" } } });
    const before = structuredClone(workflow);
    expect(diagnoseWorkflowGraph(workflow)).toMatchObject([{ code: "closed_cycle", states: ["a", "b"] }]);
    expect(workflow).toEqual(before);
  });

  it("distinguishes nonterminal dead ends from completed or paused terminals", () => {
    const workflow = run({
      a: { prompt: "A", on: { stuck: "b", done: "done", blocked: "blocked" } },
      b: { prompt: "No route" }, done: { prompt: "Done", terminal: "completed" }, blocked: { prompt: "Blocked", terminal: "paused" },
    });
    expect(diagnoseWorkflowGraph(workflow)).toMatchObject([{ code: "dead_end", states: ["b"] }]);
  });

  it("does not warn for a bounded self-loop with an available exit", () => {
    expect(diagnoseWorkflowGraph(run({ a: { prompt: "A", maxAttempts: 2, on: { retry: "a", done: "done" } }, done: { prompt: "Done", terminal: "completed" } }))).toEqual([]);
  });

  it("finds an exhausted bridge beyond the current immediate outcomes", () => {
    const workflow = run({
      a: { prompt: "A", on: { next: "b" } }, b: { prompt: "B", on: { next: "c" } },
      c: { prompt: "C", maxAttempts: 1, on: { done: "done" } }, done: { prompt: "Done", terminal: "completed" },
    });
    workflow.attemptsByState.c = 1;
    expect(diagnoseWorkflowGraph(workflow)).toMatchObject([{ code: "exhausted_route", states: ["a"], edges: [{ from: "b", outcome: "next", to: "c" }] }]);
    workflow.currentState = "c";
    expect(diagnoseWorkflowGraph(workflow)).toEqual([]);
  });

  it("does not call an exhausted optional branch a prerequisite trap", () => {
    const workflow = run({ a: { prompt: "A", on: { via: "b", done: "done" } }, b: { prompt: "B", maxAttempts: 1, on: { done: "done" } }, done: { prompt: "Done", terminal: "completed" } });
    workflow.attemptsByState.b = 1;
    expect(diagnoseWorkflowGraph(workflow)).toEqual([]);
  });

  it("keeps witness order stable across definition insertion order", () => {
    const workflow = run({ a: { prompt: "A", on: { one: "b", two: "c" } }, b: { prompt: "B" }, c: { prompt: "C" } });
    const reordered = structuredClone(workflow);
    reordered.definition.states = Object.fromEntries(Object.entries(reordered.definition.states).reverse());
    expect(diagnoseWorkflowGraph(reordered)).toEqual(diagnoseWorkflowGraph(workflow));
  });

  it("bounds inspection warnings and discloses omissions", () => {
    const workflow = run({ a: { prompt: "A", on: { one: "b", two: "c", three: "d", four: "e" } }, b: { prompt: "B" }, c: { prompt: "C" }, d: { prompt: "D" }, e: { prompt: "E" } });
    const lines = formatWorkflowGraphWarnings(workflow);
    expect(lines).toHaveLength(4);
    expect(lines.at(-1)).toContain("1 more");
    expect(lines.every((line) => line.length < 800)).toBe(true);
  });
});
