import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LoopStore } from "../src/store.js";
import type { WorkflowDefinition } from "../src/types.js";
import { validateWorkflowDefinition } from "../src/workflow-definition.js";

function documentedDefinition(): WorkflowDefinition {
  const guide = readFileSync(new URL("../docs/USAGE_GUIDE.md", import.meta.url), "utf8");
  const match = guide.match(/WorkflowCreate goal="Fix the regression" definition='([\s\S]+?)'/);
  expect(match, "the documented WorkflowCreate example must remain executable JSON").not.toBeNull();
  return JSON.parse(match![1]) as WorkflowDefinition;
}

describe("documented workflow schema expectations", () => {
  it("validates the published example and embeds initial work under creator authority", () => {
    const definition = documentedDefinition();
    expect(validateWorkflowDefinition(definition)).toBeUndefined();
    const actor = { sessionId: "example", runtimeId: "example-runtime" };
    const store = new LoopStore();
    const entry = store.create({ type: "dynamic" }, "Fix the regression", { recurring: true, workflow: definition, actor });
    expect(store.list()).toHaveLength(1);
    expect(entry.workflow?.activeExecution).toMatchObject({ stateId: "investigate", lease: { ownerSessionId: actor.sessionId, ownerRuntimeId: actor.runtimeId } });
    expect(entry.workflow?.definition.states.investigate.task?.subject).toBe("Investigate regression");
  });

  it("rejects rework metadata in the cadence field without changing the definition", () => {
    const definition = documentedDefinition();
    const invalid = { ...definition, states: { ...definition.states,
      investigate: { ...definition.states.investigate, loop: { retry: "investigate", maxAttempts: 2 } },
    } } as unknown as WorkflowDefinition;
    const before = structuredClone(invalid);
    expect(validateWorkflowDefinition(invalid)).toContain("schedule");
    expect(invalid).toEqual(before);
  });

  it("accepts bounded rework and cadence independently, without treating cadence as an outcome", () => {
    const definition = documentedDefinition();
    definition.states.investigate.on = { ...definition.states.investigate.on, retry: "investigate", ready: "fix" };
    definition.states.investigate.maxAttempts = 2;
    definition.states.investigate.loop = { schedule: "*/5 * * * *", maxFires: 3, startImmediately: false };
    const before = structuredClone(definition);
    expect(validateWorkflowDefinition(definition)).toBeUndefined();
    expect(definition).toEqual(before);
    const store = new LoopStore();
    const entry = store.create({ type: "dynamic" }, "Collect evidence", {
      recurring: true, workflow: definition, actor: { sessionId: "example", runtimeId: "runtime" },
    });
    store.fire(entry.id);
    expect(store.get(entry.id)?.workflow?.currentState).toBe("investigate");
    expect(store.get(entry.id)?.workflow?.transitionSeq).toBe(0);
  });
});
