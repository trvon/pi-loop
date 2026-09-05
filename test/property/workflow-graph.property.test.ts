import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { LoopStore } from "../../src/store.js";
import type { WorkflowDefinition } from "../../src/types.js";
import { diagnoseWorkflowGraph } from "../../src/workflow-graph.js";
import { propertyOptions } from "./config.js";

describe("workflow graph warning properties", () => {
  it("matches a bounded reachability oracle for generated closed components", () => {
    fc.assert(fc.property(fc.array(fc.integer({ min: 0, max: 255 }), { minLength: 2, maxLength: 8 }), (masks) => {
      const ids = masks.map((_, i) => `s${i}`);
      const states: WorkflowDefinition["states"] = {};
      const adjacency = masks.map((mask, from) => ids.map((_, to) => from === 0 ? to !== 0 : (mask & (1 << to)) !== 0));
      for (const [i, id] of ids.entries()) {
        states[id] = { prompt: id, maxAttempts: 3, on: Object.fromEntries(ids.filter((_, j) => adjacency[i]![j]).map((target) => [`to-${target}`, target])) };
      }
      const run = new LoopStore().create({ type: "dynamic" }, "graph", { recurring: true, workflow: { version: 1, initialState: "s0", states } }).workflow!;
      const before = structuredClone(run);
      const paths = adjacency.map((row, i) => row.map((edge, j) => edge || i === j));
      for (let k = 0; k < ids.length; k++) for (let i = 0; i < ids.length; i++) for (let j = 0; j < ids.length; j++) paths[i]![j] ||= paths[i]![k]! && paths[k]![j]!;
      const groups: string[][] = [];
      const covered = new Set<number>();
      for (let i = 0; i < ids.length; i++) {
        if (covered.has(i)) continue;
        const members = ids.map((_, j) => j).filter((j) => paths[i]![j] && paths[j]![i]);
        for (const j of members) covered.add(j);
        if (members.every((from) => adjacency[from]!.every((edge, to) => !edge || members.includes(to)))) groups.push(members.map((j) => ids[j]!).sort());
      }
      const warnings = diagnoseWorkflowGraph(run);
      expect(warnings.map((warning) => warning.states.join(",")).sort()).toEqual(groups.map((group) => group.join(",")).sort());
      expect(run).toEqual(before);
      const reordered = structuredClone(run);
      reordered.definition.states = Object.fromEntries(Object.entries(states).reverse());
      expect(diagnoseWorkflowGraph(reordered)).toEqual(warnings);
    }), propertyOptions());
  });
});
