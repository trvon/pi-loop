import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoopStore } from "../src/store.js";
import type { WorkflowDefinition } from "../src/types.js";
import { currentWorkflowIdentity } from "./helpers/workflow-identity.js";

const actor = { sessionId: "revision-session", runtimeId: "revision-owner" };
const definition: WorkflowDefinition = {
  version: 1,
  initialState: "work",
  states: {
    work: { prompt: "Work.", task: { subject: "Work", description: "Do it." }, on: { next: "future" } },
    future: { prompt: "Future.", on: { done: "complete" } },
    complete: { prompt: "Complete.", terminal: "completed" },
  },
};

function revisionInput(store: LoopStore, id: string, index: number) {
  const run = store.get(id)!.workflow!;
  return {
    expectedRevision: run.definitionRevision,
    expectedState: run.currentState,
    expectedTransitionSeq: run.transitionSeq,
    reason: `Edit ${index}`,
    changes: [{ op: "revise_state" as const, stateId: "future", prompt: `Future ${index}.` }],
  };
}

function create(store: LoopStore) {
  return store.create({ type: "dynamic" }, "Long-lived work", { recurring: true, workflow: definition, actor }).id;
}

describe("workflow revision lifetime", () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "pi-loop-revisions-"));
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(directory, { recursive: true, force: true });
  });

  it("retains every authorized revision across the old cutoff and file-backed restart", () => {
    const path = join(directory, "loops.json");
    let store = new LoopStore(path);
    const id = create(store);
    const original = structuredClone(store.get(id)!);
    for (let index = 1; index <= 64; index++) {
      if (index === 41) store = new LoopStore(path);
      const previous = structuredClone(store.get(id)!.workflow!);
      const input = revisionInput(store, id, index);
      expect(store.reviseWorkflow(id, input, actor).applied).toBe(true);
      input.changes[0]!.prompt = "Changed outside the store.";
      const run = store.get(id)!.workflow!;
      expect(run.definitionRevision).toBe(index + 1);
      expect(run.revisionHistory).toHaveLength(index);
      expect(run.revisionHistory.at(-1)).toEqual({
        revision: index, definition: previous.definition, reason: `Edit ${index}`,
        supersededAt: 10_000, supersededBy: actor,
        changes: [{ op: "revise_state", stateId: "future", prompt: `Future ${index}.` }],
      });
      expect(run.activeExecution).toEqual(original.workflow!.activeExecution);
      expect(run.transitionSeq).toBe(0);
      expect(run.attemptsByState).toEqual(original.workflow!.attemptsByState);
      expect(store.get(id)!.expiresAt).toBe(original.expiresAt);
    }
    const run = new LoopStore(path).get(id)!.workflow!;
    expect(run.revisionHistory.map((record) => record.revision)).toEqual(Array.from({ length: 64 }, (_, i) => i + 1));
    expect(run.revisionHistory[0]!.definition).toEqual(definition);
    const before = readFileSync(path, "utf8");
    const input = revisionInput(store, id, 65);
    expect(store.reviseWorkflow(id, { ...input, expectedRevision: 32 }, actor).failure?.code).toBe("revision_conflict");
    expect(store.reviseWorkflow(id, { ...input, expectedTransitionSeq: 1 }, actor).failure?.code).toBe("run_conflict");
    expect(store.reviseWorkflow(id, input, { ...actor, runtimeId: "foreign" }).failure?.code).toBe("lease_owned_elsewhere");
    expect(store.transitionWorkflow(id, { outcome: "next", actor }, {
      ...currentWorkflowIdentity(store, id), definitionRevision: 32,
    }).applied).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(store.reviseWorkflow(id, input, actor).applied).toBe(true);
    expect(new LoopStore(path).get(id)!.workflow!.definitionRevision).toBe(66);
  });

  it("reissues beyond the old cutoff without resetting revision identity or losing history", () => {
    const store = new LoopStore();
    const id = create(store);
    const original = structuredClone(store.get(id)!);
    const identities = new Set([original.workflow!.activeExecution!.id]);
    for (let index = 1; index <= 64; index++) {
      const stale = currentWorkflowIdentity(store, id);
      const input = revisionInput(store, id, index);
      expect(store.reviseWorkflow(id, {
        ...input, changes: [{ op: "reissue_state", stateId: "work", prompt: `Work ${index}.` }],
      }, actor).applied).toBe(true);
      const run = store.get(id)!.workflow!;
      expect(run.activeExecution!.id).toBe(`work:0:r${index + 1}`);
      expect(identities.has(run.activeExecution!.id)).toBe(false);
      identities.add(run.activeExecution!.id);
      expect(run.activeExecution!.lease).toEqual(original.workflow!.activeExecution!.lease);
      expect(run.attemptsByState).toEqual(original.workflow!.attemptsByState);
      expect(run.executionHistory).toHaveLength(index);
      expect(run.revisionHistory).toHaveLength(index);
      expect(run.executionHistory!.at(-1)).toMatchObject({ id: stale.activeExecutionId, status: "cancelled" });
      const before = structuredClone(store.get(id));
      expect(store.transitionWorkflow(id, { outcome: "next", actor }, {
        ...stale, definitionRevision: run.definitionRevision,
      }).applied).toBe(false);
      expect(store.get(id)).toEqual(before);
    }
    expect(identities.size).toBe(65);
    expect(store.transitionWorkflow(id, { outcome: "next", actor }, currentWorkflowIdentity(store, id)).applied).toBe(true);
  });
});
