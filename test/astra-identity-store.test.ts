import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoopStore } from "../src/store.js";

const actor = { sessionId: "session-a", runtimeId: "runtime-a" };

function createOwnedWork(store: LoopStore) {
  return store.create({ type: "dynamic" }, "Implement and review", {
    recurring: true,
    actor,
    workflow: {
      version: 1,
      initialState: "work",
      states: {
        work: {
          prompt: "Implement the original requirement.",
          task: { subject: "Implement", description: "Implement the original requirement." },
          on: { ready: "review" },
        },
        review: { prompt: "Review implementation.", on: { done: "done" } },
        done: { prompt: "Report success.", terminal: "completed" },
      },
    },
  });
}

function reissue(store: LoopStore, id: string) {
  expect(store.reviseWorkflow(id, {
    expectedRevision: 1,
    expectedState: "work",
    expectedTransitionSeq: 0,
    reason: "The original instructions are obsolete.",
    changes: [{
      op: "reissue_state",
      stateId: "work",
      prompt: "Implement the replacement requirement.",
      task: { subject: "Replacement", description: "Implement the replacement requirement." },
    }],
  }, actor).applied).toBe(true);
  expect(store.get(id)?.workflow).toMatchObject({
    definitionRevision: 2,
    currentState: "work",
    transitionSeq: 0,
    activeExecution: { id: "work:0:r2", status: "active", lease: { ownerRuntimeId: actor.runtimeId } },
    executionHistory: [{ id: "work:0", status: "cancelled" }],
  });
}

describe("Astra execution identity Store regressions", () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    dir = mkdtempSync(join(tmpdir(), "pi-loop-astra-identity-"));
    path = join(dir, "loops.json");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it("AUD-08: a monitor attachment captured before reissue cannot attach to the replacement execution", () => {
    const a = new LoopStore(path);
    const entry = createOwnedWork(a);
    const captured = {
      stateId: entry.workflow!.currentState,
      transitionSeq: entry.workflow!.transitionSeq,
      definitionRevision: entry.workflow!.definitionRevision,
      activeExecutionId: entry.workflow!.activeExecution!.id,
    };
    const b = new LoopStore(path);
    reissue(a, entry.id);
    const replacement = structuredClone(a.get(entry.id)?.workflow?.activeExecution);
    const before = readFileSync(path, "utf8");

    expect.soft(b.attachWorkflowMonitor(entry.id, "obsolete-monitor", captured)).toBeUndefined();
    const after = new LoopStore(path).get(entry.id)?.workflow;
    expect.soft(after?.waitingMonitor).toBeUndefined();
    expect.soft(after?.activeExecution).toEqual(replacement);
    expect.soft(readFileSync(path, "utf8")).toBe(before);
  });

  it.each(["omitted", "pre-reissue"] as const)("AUD-11: a delayed transition with %s CAS cannot settle reissued work", (identity) => {
    const a = new LoopStore(path);
    const entry = createOwnedWork(a);
    const captured = {
      currentState: entry.workflow!.currentState,
      transitionSeq: entry.workflow!.transitionSeq,
      definitionRevision: entry.workflow!.definitionRevision,
      activeExecutionId: entry.workflow!.activeExecution!.id,
    };
    const delayedCaller = new LoopStore(path);
    const delayedInput = { outcome: "ready", actor, evidence: "The original requirement is implemented." };
    reissue(a, entry.id);
    const replacement = structuredClone(a.get(entry.id)?.workflow);
    const before = readFileSync(path, "utf8");

    const result = identity === "omitted"
      ? delayedCaller.transitionWorkflow(entry.id, delayedInput)
      : delayedCaller.transitionWorkflow(entry.id, delayedInput, captured);

    expect.soft(result.applied).toBe(false);
    expect.soft(new LoopStore(path).get(entry.id)?.workflow).toEqual(replacement);
    expect.soft(readFileSync(path, "utf8")).toBe(before);
  });
});
