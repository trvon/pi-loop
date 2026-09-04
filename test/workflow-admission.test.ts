import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoopStore } from "../src/store.js";
import { TaskStore } from "../src/task-store.js";
import {
  admitWorkflowTransition,
  reconcileWorkflowClaim,
  type WorkflowAdmissionContext,
  type WorkflowAdmissionObservation,
  type WorkflowAdmissionProvider,
  type WorkflowBlockerClaim,
} from "../src/workflow-admission.js";
import { currentWorkflowIdentity } from "./helpers/workflow-identity.js";

const NOW = 1_800_000_000_000;
const directories: string[] = [];

function createStore() {
  const directory = mkdtempSync(join(tmpdir(), "pi-loop-workflow-admission-"));
  directories.push(directory);
  const path = join(directory, "loops.json");
  const store = new LoopStore(path);
  const entry = store.create({ type: "dynamic" }, "Validate release", {
    recurring: true,
    workflow: {
      version: 1,
      initialState: "validate",
      states: {
        validate: {
          prompt: "Validate release.",
          on: { continue: "ship", race: "review", blocked: "blocked" },
        },
        review: { prompt: "Review.", on: { continue: "ship" } },
        ship: { prompt: "Ship.", terminal: "completed" },
        blocked: { prompt: "Report blocker.", terminal: "paused" },
      },
    },
  });
  return { path, store, entry };
}

function context(entry: ReturnType<LoopStore["get"]>, contextDigest = "workspace-A"): WorkflowAdmissionContext {
  if (!entry?.workflow) throw new Error("expected workflow");
  return {
    workflowId: entry.id,
    currentState: entry.workflow.currentState,
    transitionSeq: entry.workflow.transitionSeq,
    definitionRevision: entry.workflow.definitionRevision,
    activeExecutionId: entry.workflow.activeExecution?.id,
    contextDigest,
  };
}

function claim(): WorkflowBlockerClaim {
  return {
    class: "environmental",
    provider: "test",
    subject: "release-check",
    fact: "failed",
    expected: true,
  };
}

function observed(
  scoped: WorkflowAdmissionContext,
  actual: boolean | number = true,
  provider = "test",
): WorkflowAdmissionObservation {
  return {
    fact: "failed",
    actual,
    sourceClass: "environmental",
    provider,
    providerVersion: "1",
    observedAt: NOW,
    expiresAt: NOW + 1_000,
    context: scoped,
    status: "observed",
  };
}

function provider(observations: (input: { context: WorkflowAdmissionContext }) => WorkflowAdmissionObservation[]): WorkflowAdmissionProvider {
  return {
    id: "test",
    sourceClass: "environmental",
    observe: vi.fn(async (input) => observations(input)),
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("workflow transition admission", () => {
  it("allows ordinary declared transitions without blocker admission", async () => {
    const { store, entry } = createStore();
    const result = await admitWorkflowTransition({
      store,
      workflowId: entry.id,
      outcome: "continue",
      contextDigest: "workspace-A",
      providers: [],
      now: NOW,
    });

    expect(result).toMatchObject({
      decision: { decision: "not_required" },
      transition: { applied: true, terminal: "completed" },
    });
  });

  it("requires a grounded claim before entering a paused terminal state", async () => {
    const { path, store, entry } = createStore();
    const before = readFileSync(path);
    const result = await admitWorkflowTransition({
      store,
      workflowId: entry.id,
      outcome: "blocked",
      contextDigest: "workspace-A",
      providers: [],
      now: NOW,
    });

    expect(result).toMatchObject({ decision: { decision: "unresolved", reason: "claim_required" } });
    expect(result.transition).toBeUndefined();
    expect(readFileSync(path)).toEqual(before);
  });

  it("runs trusted providers before the CAS transition and records semantic pause provenance", async () => {
    const { store, entry } = createStore();
    const trusted = provider(({ context: scoped }) => {
      expect(store.get(entry.id)?.status).toBe("active");
      return [observed(scoped)];
    });
    const result = await admitWorkflowTransition({
      store,
      workflowId: entry.id,
      outcome: "blocked",
      claim: claim(),
      contextDigest: "workspace-A",
      providers: [trusted],
      now: NOW,
    });

    expect(trusted.observe).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ decision: { decision: "confirmed" }, transition: { applied: true, terminal: "paused" } });
    expect(store.get(entry.id)).toMatchObject({
      pause: { kind: "semantic_terminal" },
      workflow: {
        lastTransition: {
          admission: {
            claimClass: "environmental",
            provider: "test",
            subject: "release-check",
            fact: "failed",
            expected: true,
            observations: ["test@1"],
            decidedAt: NOW,
          },
        },
      },
    });
  });

  it("uses one equality relation for conflicts and final comparison", () => {
    const { entry } = createStore();
    const scoped = context(entry);
    expect(reconcileWorkflowClaim(claim(), [observed(scoped, 0), observed(scoped, -0)], scoped, NOW))
      .toMatchObject({ decision: "unresolved", reason: "conflicting_observations" });
  });

  it("rejects stale provider context and preserves the workflow bytes", async () => {
    const { path, store, entry } = createStore();
    const before = readFileSync(path);
    const stale = provider(({ context: scoped }) => [observed({ ...scoped, contextDigest: "workspace-B" })]);
    const result = await admitWorkflowTransition({
      store,
      workflowId: entry.id,
      outcome: "blocked",
      claim: claim(),
      contextDigest: "workspace-A",
      providers: [stale],
      now: NOW,
    });

    expect(result).toMatchObject({ decision: { decision: "unresolved", reason: "no_current_observation" } });
    expect(result.transition).toBeUndefined();
    expect(readFileSync(path)).toEqual(before);
  });

  it("never treats environmental providers as user authority", async () => {
    const { path, store, entry } = createStore();
    const before = readFileSync(path);
    const authorityClaim: WorkflowBlockerClaim = { ...claim(), class: "user_authority" };
    const result = await admitWorkflowTransition({
      store,
      workflowId: entry.id,
      outcome: "blocked",
      claim: authorityClaim,
      contextDigest: "workspace-A",
      providers: [provider(({ context: scoped }) => [observed(scoped)])],
      now: NOW,
    });

    expect(result).toMatchObject({ decision: { decision: "requires_user_authority", reason: "provider_unavailable" } });
    expect(result.transition).toBeUndefined();
    expect(readFileSync(path)).toEqual(before);
  });

  it("rechecks expiry after provider execution", async () => {
    const { path, store, entry } = createStore();
    const before = readFileSync(path);
    let clockReads = 0;
    const expiring = provider(({ context: scoped }) => [observed(scoped)]);
    const result = await admitWorkflowTransition({
      store,
      workflowId: entry.id,
      outcome: "blocked",
      claim: claim(),
      contextDigest: "workspace-A",
      providers: [expiring],
      now: () => clockReads++ === 0 ? NOW : NOW + 2_000,
    });

    expect(result).toMatchObject({ decision: { decision: "unresolved", reason: "no_current_observation" } });
    expect(result.transition).toBeUndefined();
    expect(readFileSync(path)).toEqual(before);
  });

  it("rejects oversized fact values without writing", async () => {
    const { path, store, entry } = createStore();
    const before = readFileSync(path);
    const result = await admitWorkflowTransition({
      store,
      workflowId: entry.id,
      outcome: "blocked",
      claim: { ...claim(), expected: "x".repeat(1_025) },
      contextDigest: "workspace-A",
      providers: [provider(({ context: scoped }) => [observed(scoped)])],
      now: NOW,
    });

    expect(result).toMatchObject({ decision: { decision: "unresolved", reason: "invalid_claim" } });
    expect(result.transition).toBeUndefined();
    expect(readFileSync(path)).toEqual(before);
  });

  it("rejects contradicted, expired, abstained, and errored evidence without writing", async () => {
    const cases: Array<{
      label: string;
      mutate: (item: WorkflowAdmissionObservation) => WorkflowAdmissionObservation;
      decision: string;
    }> = [
      { label: "contradicted", mutate: (item) => ({ ...item, actual: false }), decision: "contradicted" },
      { label: "expired", mutate: (item) => ({ ...item, expiresAt: NOW - 1 }), decision: "unresolved" },
      { label: "abstained", mutate: (item) => ({ ...item, status: "abstained" }), decision: "unresolved" },
      { label: "error", mutate: (item) => ({ ...item, status: "error" }), decision: "unresolved" },
    ];

    for (const testCase of cases) {
      const { path, store, entry } = createStore();
      const before = readFileSync(path);
      const resolver = provider(({ context: scoped }) => [testCase.mutate(observed(scoped))]);
      const result = await admitWorkflowTransition({
        store,
        workflowId: entry.id,
        outcome: "blocked",
        claim: claim(),
        contextDigest: "workspace-A",
        providers: [resolver],
        now: NOW,
      });

      expect(result.decision.decision, testCase.label).toBe(testCase.decision);
      expect(result.transition, testCase.label).toBeUndefined();
      expect(readFileSync(path), testCase.label).toEqual(before);
    }
  });

  it("rejects replay across workflow, state, revision, execution, and workspace boundaries", async () => {
    const mutations: Array<{
      label: string;
      mutate: (item: WorkflowAdmissionContext) => WorkflowAdmissionContext;
    }> = [
      { label: "workflow", mutate: (item) => ({ ...item, workflowId: "other-workflow" }) },
      { label: "state", mutate: (item) => ({ ...item, currentState: "other-state" }) },
      { label: "revision", mutate: (item) => ({ ...item, definitionRevision: item.definitionRevision + 1 }) },
      { label: "execution", mutate: (item) => ({ ...item, activeExecutionId: "other-execution" }) },
      { label: "workspace", mutate: (item) => ({ ...item, contextDigest: "workspace-B" }) },
    ];

    for (const replay of mutations) {
      const { path, store, entry } = createStore();
      const before = readFileSync(path);
      const stale = provider(({ context: scoped }) => [observed(replay.mutate(scoped))]);
      const result = await admitWorkflowTransition({
        store,
        workflowId: entry.id,
        outcome: "blocked",
        claim: claim(),
        contextDigest: "workspace-A",
        providers: [stale],
        now: NOW,
      });

      expect(result, replay.label).toMatchObject({ decision: { decision: "unresolved", reason: "no_current_observation" } });
      expect(result.transition, replay.label).toBeUndefined();
      expect(readFileSync(path), replay.label).toEqual(before);
    }
  });

  it("resubmits after file-backed store recreation without pending proposal state", async () => {
    const { path, store, entry } = createStore();
    const taskPath = join(path, "..", "tasks.json");
    const taskStore = new TaskStore(taskPath);
    taskStore.create({ subject: "Independent", description: "Must remain untouched" });
    const taskBytes = readFileSync(taskPath);
    const waiting = await admitWorkflowTransition({
      store,
      workflowId: entry.id,
      outcome: "blocked",
      claim: claim(),
      contextDigest: "workspace-A",
      providers: [],
      now: NOW,
    });
    expect(waiting).toMatchObject({ decision: { decision: "unresolved", reason: "provider_unavailable" } });

    const restarted = new LoopStore(path);
    const fresh = provider(({ context: scoped }) => [observed(scoped)]);
    const resumed = await admitWorkflowTransition({
      store: restarted,
      workflowId: entry.id,
      outcome: "blocked",
      claim: claim(),
      contextDigest: "workspace-A",
      providers: [fresh],
      now: NOW,
    });

    expect(resumed).toMatchObject({ decision: { decision: "confirmed" }, transition: { applied: true } });
    expect(readFileSync(taskPath)).toEqual(taskBytes);
  });

  it("admits user authority only through a matching trusted authority provider", async () => {
    const { store, entry } = createStore();
    const authorityClaim: WorkflowBlockerClaim = {
      class: "user_authority",
      provider: "approval",
      subject: "release",
      fact: "approved",
      expected: true,
    };
    const authority: WorkflowAdmissionProvider = {
      id: "approval",
      sourceClass: "user_authority",
      async observe({ claim: requested, context: scoped, now }) {
        return [{
          fact: requested.fact,
          actual: true,
          sourceClass: "user_authority",
          provider: "approval",
          providerVersion: "1",
          observedAt: now,
          expiresAt: now + 1_000,
          context: scoped,
          status: "observed",
        }];
      },
    };
    const result = await admitWorkflowTransition({
      store,
      workflowId: entry.id,
      outcome: "blocked",
      claim: authorityClaim,
      contextDigest: "workspace-A",
      providers: [authority],
      now: NOW,
    });

    expect(result).toMatchObject({ decision: { decision: "confirmed" }, transition: { applied: true } });
  });

  it("rejects a provider result after the runtime context changes", async () => {
    const { path, store, entry } = createStore();
    const before = readFileSync(path);
    let current = true;
    const switching = provider(({ context: scoped }) => {
      current = false;
      return [observed(scoped)];
    });
    const result = await admitWorkflowTransition({
      store,
      workflowId: entry.id,
      outcome: "blocked",
      claim: claim(),
      contextDigest: "workspace-A",
      providers: [switching],
      now: NOW,
      isContextCurrent: () => current,
    });

    expect(result).toMatchObject({ decision: { decision: "unresolved", reason: "stale_runtime_context" } });
    expect(result.transition).toBeUndefined();
    expect(readFileSync(path)).toEqual(before);
  });

  it("rejects a confirmed claim when a competing transition wins the CAS race", async () => {
    const { store, entry } = createStore();
    const racing = provider(({ context: scoped }) => {
      expect(store.transitionWorkflow(entry.id, { outcome: "race" }, currentWorkflowIdentity(store, entry.id))).toMatchObject({ applied: true });
      return [observed(scoped)];
    });
    const result = await admitWorkflowTransition({
      store,
      workflowId: entry.id,
      outcome: "blocked",
      claim: claim(),
      contextDigest: "workspace-A",
      providers: [racing],
      now: NOW,
    });

    expect(result).toMatchObject({
      decision: { decision: "confirmed" },
      transition: { applied: false, error: expect.stringContaining("changed") },
    });
  });
});
