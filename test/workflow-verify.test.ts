import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkflowVerifier } from "../src/runtime/verify-runner.js";
import { LoopStore } from "../src/store.js";
import type { OrchestrationVerification, WorkflowDefinition } from "../src/types.js";
import { admitWorkflowTransition } from "../src/workflow-admission.js";
import { validateWorkflowDefinition } from "../src/workflow-definition.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function definition(verify: WorkflowDefinition["states"][string]["verify"]): WorkflowDefinition {
  return {
    version: 1,
    initialState: "build",
    states: {
      build: { prompt: "Build it.", on: { done: "review", rework: "build", blocked: "blocked" }, maxAttempts: 2, verify },
      review: { prompt: "Review.", on: { done: "ship" } },
      ship: { prompt: "Ship.", terminal: "completed" },
      blocked: { prompt: "Report blocker.", terminal: "paused" },
    },
  };
}

function createStore(verify: WorkflowDefinition["states"][string]["verify"]) {
  const directory = mkdtempSync(join(tmpdir(), "pi-loop-workflow-verify-"));
  directories.push(directory);
  const store = new LoopStore(join(directory, "loops.json"));
  const entry = store.create({ type: "dynamic" }, "Build", { recurring: true, workflow: definition(verify) });
  return { store, entry };
}

const pass: OrchestrationVerification = { passed: true, exitCode: 0, durationMs: 5 };
const fail: OrchestrationVerification = { passed: false, exitCode: 2, durationMs: 5, output: "3 tests failed" };

function admit(store: LoopStore, id: string, outcome: string, runVerify?: (command: string) => Promise<OrchestrationVerification>, isContextCurrent?: () => boolean) {
  return admitWorkflowTransition({ store, workflowId: id, outcome, evidence: "model says done", contextDigest: "ctx", providers: [], runVerify, isContextCurrent });
}

describe("verified workflow transitions", () => {
  it("admits a verified outcome only after its check passes and records the check as admission", async () => {
    const { store, entry } = createStore({ done: { command: "npm test" } });
    const runVerify = vi.fn(async () => pass);
    const result = await admit(store, entry.id, "done", runVerify);
    expect(runVerify).toHaveBeenCalledWith("npm test");
    expect(result.decision).toMatchObject({ decision: "confirmed", reason: "verify_passed" });
    expect(result.transition?.applied).toBe(true);
    const workflow = store.get(entry.id)!.workflow!;
    expect(workflow.currentState).toBe("review");
    expect(workflow.lastTransition).toMatchObject({
      outcome: "done",
      admission: { claimClass: "environmental", provider: "verify", subject: "npm test", fact: "exit_code", expected: 0 },
    });
  });

  it("rejects a failed check without onFail and preserves state", async () => {
    const { store, entry } = createStore({ done: { command: "npm test" } });
    const before = structuredClone(store.get(entry.id));
    const result = await admit(store, entry.id, "done", async () => fail);
    expect(result.decision).toMatchObject({ decision: "contradicted", reason: "verify_failed" });
    expect(result.transition).toBeUndefined();
    expect(result.verification).toEqual(fail);
    expect(store.get(entry.id)).toEqual(before);
  });

  it("takes the onFail outcome with the failure as evidence, within its attempt budget", async () => {
    const { store, entry } = createStore({ done: { command: "npm test", onFail: "rework" } });
    const first = await admit(store, entry.id, "done", async () => fail);
    expect(first.decision).toMatchObject({ decision: "contradicted", reason: "verify_failed" });
    expect(first.appliedOutcome).toBe("rework");
    expect(first.transition?.applied).toBe(true);
    const workflow = store.get(entry.id)!.workflow!;
    expect(workflow.currentState).toBe("build");
    expect(workflow.lastTransition?.outcome).toBe("rework");
    expect(workflow.lastTransition?.evidence).toContain("exit 2");
    expect(workflow.lastTransition?.evidence).toContain("3 tests failed");

    await admit(store, entry.id, "done", async () => fail);
    const exhausted = await admit(store, entry.id, "done", async () => fail);
    expect(exhausted.transition?.applied).toBe(false);
    expect(store.get(entry.id)!.workflow!.currentState).toBe("build");
  });

  it("does not run checks for outcomes that declare none", async () => {
    const { store, entry } = createStore({ done: { command: "npm test", onFail: "rework" } });
    const runVerify = vi.fn(async () => pass);
    const result = await admit(store, entry.id, "rework", runVerify);
    expect(runVerify).not.toHaveBeenCalled();
    expect(result.decision.decision).toBe("not_required");
    expect(result.transition?.applied).toBe(true);
  });

  it("stays unresolved without a verifier and when the context changes during the check", async () => {
    const { store, entry } = createStore({ done: { command: "npm test" } });
    const before = structuredClone(store.get(entry.id));
    expect((await admit(store, entry.id, "done")).decision).toMatchObject({ decision: "unresolved", reason: "verifier_unavailable" });
    let current = true;
    const stale = await admit(store, entry.id, "done", async () => { current = false; return pass; }, () => current);
    expect(stale.decision).toMatchObject({ decision: "unresolved", reason: "stale_runtime_context" });
    expect(store.get(entry.id)).toEqual(before);
  });

  it("treats a verifier that throws as a failed check", async () => {
    const { store, entry } = createStore({ done: { command: "npm test" } });
    const result = await admit(store, entry.id, "done", async () => { throw new Error("spawn EACCES"); });
    expect(result.decision).toMatchObject({ decision: "contradicted", reason: "verify_failed" });
    expect(result.verification).toMatchObject({ passed: false, exitCode: null });
    expect(result.verification?.output).toContain("spawn EACCES");
  });
});

describe("verified transition definitions", () => {
  const valid = (verify: WorkflowDefinition["states"][string]["verify"]) => validateWorkflowDefinition(definition(verify));

  it("accepts checks on declared outcomes with a declared onFail", () => {
    expect(valid({ done: { command: "npm test", onFail: "rework" } })).toBeUndefined();
    expect(valid(undefined)).toBeUndefined();
  });

  it("rejects malformed checks", () => {
    expect(valid({ nope: { command: "npm test" } })).toContain("undeclared outcome");
    expect(valid({ done: { command: "  " } })).toContain("command");
    expect(valid({ done: { command: "x".repeat(5000) } })).toContain("command");
    expect(valid({ done: { command: "npm test", onFail: "missing" } })).toContain("onFail");
    expect(valid({ done: { command: "npm test", onFail: "done" } })).toContain("onFail");
    expect(valid({ done: { command: "npm test", onFail: "rework" }, rework: { command: "true" } })).toContain("onFail");
    expect(valid({ blocked: { command: "true" } })).toContain("paused terminal");
  });
});

describe("review regressions: verified transitions", () => {
  it("C1: gates on exit status 0, not a passed flag that disagrees with it", async () => {
    for (const inconsistent of [{ passed: true, exitCode: 1, durationMs: 1 }, { passed: true, exitCode: null, durationMs: 1 }]) {
      const { store, entry } = createStore({ done: { command: "npm test" } });
      const before = structuredClone(store.get(entry.id));
      const result = await admit(store, entry.id, "done", async () => inconsistent);
      expect(result.decision).toMatchObject({ decision: "contradicted", reason: "verify_failed" });
      expect(store.get(entry.id)).toEqual(before);
    }
  });

  it("C2: aborting session verifiers stops a running check", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-loop-workflow-verifier-"));
    directories.push(directory);
    const verifier = createWorkflowVerifier(() => directory);
    const running = verifier.run("sleep 30");
    verifier.abortAll();
    const result = await running;
    expect(result).toMatchObject({ passed: false, exitCode: null });
    expect(result.durationMs).toBeLessThan(5_000);
    expect((await verifier.run("true")).passed).toBe(true);
  });

  it("C3: rejects onFail outcomes that target a paused terminal", () => {
    const definitionWithPausedFallback = definition({ done: { command: "npm test", onFail: "blocked" } });
    expect(validateWorkflowDefinition(definitionWithPausedFallback)).toContain("onFail");
  });
});
