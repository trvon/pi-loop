import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LoopStore } from "../src/store.js";
import { TaskStore } from "../src/task-store.js";
import {
  attemptClaimedTransition,
  contextFor,
  type ExperimentClaim,
  type ExperimentObservation,
  reconcileClaim,
} from "./experiments/blocker-reconciliation-experiment.js";

const NOW = 1_800_000_000_000;
const directories: string[] = [];

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "pi-loop-reconciliation-experiment-"));
  directories.push(directory);
  const loopPath = join(directory, "loops.json");
  const taskPath = join(directory, "tasks.json");
  const loopStore = new LoopStore(loopPath);
  const taskStore = new TaskStore(taskPath);
  const workflow = loopStore.create({ type: "dynamic" }, "Assess a claimed blocker", {
    recurring: true,
    workflow: {
      version: 1,
      initialState: "assess",
      states: {
        assess: {
          prompt: "Assess the blocker claim.",
          on: { blocked: "blocked", continue: "review" },
        },
        review: {
          prompt: "Continue reviewing.",
          on: { blocked: "blocked" },
        },
        blocked: { prompt: "Wait for resolution.", terminal: "paused" },
      },
    },
  });
  taskStore.create("Sentinel task", "This standalone task must remain byte-identical during workflow reconciliation.");
  return { directory, loopPath, taskPath, loopStore, taskStore, workflow };
}

function environmentalClaim(
  context: ReturnType<typeof contextFor>,
  fact: string,
  expected: string | number | boolean | null,
): ExperimentClaim {
  return { class: "environmental", fact, expected, context };
}

function observation(
  context: ReturnType<typeof contextFor>,
  fact: string,
  actual: string | number | boolean | null,
  overrides: Partial<ExperimentObservation> = {},
): ExperimentObservation {
  return {
    fact,
    actual,
    sourceClass: "deterministic",
    provider: "fixture",
    providerVersion: "1",
    observedAt: NOW - 10,
    expiresAt: NOW + 1_000,
    context,
    status: "observed",
    ...overrides,
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("test-only blocker reconciliation experiment", () => {
  it("E1/E4 resolves normalized environmental facts without provider-specific core logic", () => {
    const { workflow } = setup();
    const context = contextFor(workflow, "workspace-A");

    expect(reconcileClaim(
      environmentalClaim(context, "repository_dirty", true),
      [observation(context, "repository_dirty", false)],
      NOW,
    )).toMatchObject({ decision: "contradicted" });
    expect(reconcileClaim(
      environmentalClaim(context, "artifact_present", true),
      [observation(context, "artifact_present", true, { provider: "repository-fact" })],
      NOW,
    )).toMatchObject({ decision: "confirmed" });
  });

  it("E2/E5 never derives user authority from machine evidence or another workflow scope", () => {
    const { workflow } = setup();
    const context = contextFor(workflow, "workspace-A");
    const claim: ExperimentClaim = {
      class: "user_authority",
      fact: "destructive_change_approved",
      expected: true,
      context,
    };

    expect(reconcileClaim(claim, [observation(context, claim.fact, true)], NOW)).toMatchObject({
      decision: "requires_user_authority",
    });
    expect(reconcileClaim(claim, [observation(
      { ...context, workflowId: "other-workflow" },
      claim.fact,
      true,
      { sourceClass: "user_authority", provider: "explicit-user-decision" },
    )], NOW)).toMatchObject({ decision: "requires_user_authority" });
    expect(reconcileClaim(claim, [observation(
      context,
      claim.fact,
      true,
      { sourceClass: "user_authority", provider: "explicit-user-decision" },
    )], NOW)).toMatchObject({ decision: "confirmed" });
  });

  it("E3 treats monitor status as a narrow fact and conflicts as unresolved", () => {
    const { workflow } = setup();
    const context = contextFor(workflow, "workspace-A");
    const claim = environmentalClaim(context, "validation_process_failed", true);

    expect(reconcileClaim(claim, [observation(
      context,
      claim.fact,
      false,
      { provider: "monitor-terminal-status" },
    )], NOW)).toMatchObject({ decision: "contradicted" });
    expect(reconcileClaim(claim, [
      observation(context, claim.fact, false, { provider: "monitor-A" }),
      observation(context, claim.fact, true, { provider: "monitor-B" }),
    ], NOW)).toMatchObject({ decision: "unresolved", reason: "conflicting_observations" });
  });

  it("E6 leaves absent, abstained, and provider-error evidence unresolved", () => {
    const { workflow } = setup();
    const context = contextFor(workflow, "workspace-A");
    const claim = environmentalClaim(context, "service_available", true);

    expect(reconcileClaim(claim, [], NOW)).toMatchObject({ decision: "unresolved" });
    expect(reconcileClaim(claim, [observation(context, claim.fact, true, { status: "abstained" })], NOW))
      .toMatchObject({ decision: "unresolved" });
    expect(reconcileClaim(claim, [observation(context, claim.fact, true, { status: "error" })], NOW))
      .toMatchObject({ decision: "unresolved" });
  });

  it("E7 rejects expired and context-mismatched observations", () => {
    const { workflow } = setup();
    const context = contextFor(workflow, "workspace-A");
    const claim = environmentalClaim(context, "repository_dirty", true);

    expect(reconcileClaim(claim, [observation(context, claim.fact, true, { expiresAt: NOW - 1 })], NOW))
      .toMatchObject({ decision: "unresolved", reason: "no_current_observation" });
    expect(reconcileClaim(claim, [observation(
      { ...context, transitionSeq: context.transitionSeq + 1 },
      claim.fact,
      true,
    )], NOW)).toMatchObject({ decision: "unresolved", reason: "no_current_observation" });
  });

  it("E8 admits one confirmed claim through the actual LoopStore CAS path without touching TaskStore", () => {
    const { loopPath, taskPath, loopStore, workflow } = setup();
    const context = contextFor(workflow, "workspace-A");
    const taskBytes = readFileSync(taskPath);
    const result = attemptClaimedTransition({
      store: loopStore,
      workflowId: workflow.id,
      outcome: "blocked",
      claim: environmentalClaim(context, "repository_dirty", true),
      observations: [observation(context, "repository_dirty", true)],
      now: NOW,
    });

    expect(result).toMatchObject({ decision: { decision: "confirmed" }, transition: { applied: true, terminal: "paused" } });
    expect(loopStore.get(workflow.id)).toMatchObject({ status: "paused", workflow: { currentState: "blocked", transitionSeq: 1 } });
    expect(readFileSync(loopPath)).not.toHaveLength(0);
    expect(readFileSync(taskPath)).toEqual(taskBytes);
  });

  it.each([
    ["contradicted", false, "observed"],
    ["unresolved", true, "abstained"],
    ["provider error", true, "error"],
  ] as const)("E8 preserves exact store bytes when a claim is %s", (_label, actual, status) => {
    const { loopPath, taskPath, loopStore, workflow } = setup();
    const context = contextFor(workflow, "workspace-A");
    const loopBytes = readFileSync(loopPath);
    const taskBytes = readFileSync(taskPath);

    const result = attemptClaimedTransition({
      store: loopStore,
      workflowId: workflow.id,
      outcome: "blocked",
      claim: environmentalClaim(context, "repository_dirty", true),
      observations: [observation(context, "repository_dirty", actual, { status })],
      now: NOW,
    });

    expect(result.transition).toBeUndefined();
    expect(readFileSync(loopPath)).toEqual(loopBytes);
    expect(readFileSync(taskPath)).toEqual(taskBytes);
  });

  it("E7/E8 preserves exact bytes for expired, stale-scope, unauthorized, and malformed evidence", () => {
    const cases: Array<{
      label: string;
      claimClass?: ExperimentClaim["class"];
      mutate: (item: ExperimentObservation) => ExperimentObservation;
    }> = [
      { label: "expired", mutate: (item) => ({ ...item, expiresAt: NOW - 1 }) },
      {
        label: "stale scope",
        mutate: (item) => ({
          ...item,
          context: { ...item.context, definitionRevision: item.context.definitionRevision + 1 },
        }),
      },
      { label: "unauthorized", claimClass: "user_authority", mutate: (item) => item },
      { label: "malformed provider", mutate: (item) => ({ ...item, provider: "" }) },
    ];

    for (const testCase of cases) {
      const { loopPath, taskPath, loopStore, workflow } = setup();
      const context = contextFor(workflow, "workspace-A");
      const loopBytes = readFileSync(loopPath);
      const taskBytes = readFileSync(taskPath);
      const claim: ExperimentClaim = {
        class: testCase.claimClass ?? "environmental",
        fact: "repository_dirty",
        expected: true,
        context,
      };
      const result = attemptClaimedTransition({
        store: loopStore,
        workflowId: workflow.id,
        outcome: "blocked",
        claim,
        observations: [testCase.mutate(observation(context, claim.fact, true))],
        now: NOW,
      });

      expect(result.transition, testCase.label).toBeUndefined();
      expect(readFileSync(loopPath), testCase.label).toEqual(loopBytes);
      expect(readFileSync(taskPath), testCase.label).toEqual(taskBytes);
    }
  });

  it("E8 allows a competing transition to win but rejects the stale confirmed admission", () => {
    const { loopStore, workflow } = setup();
    const context = contextFor(workflow, "workspace-A");
    const result = attemptClaimedTransition({
      store: loopStore,
      workflowId: workflow.id,
      outcome: "blocked",
      claim: environmentalClaim(context, "repository_dirty", true),
      observations: [observation(context, "repository_dirty", true)],
      now: NOW,
      beforeCommit: (expected) => {
        expect(loopStore.transitionWorkflow(workflow.id, { outcome: "continue" }, expected)).toMatchObject({ applied: true });
      },
    });

    expect(result).toMatchObject({
      decision: { decision: "confirmed" },
      transition: { applied: false, error: expect.stringContaining("changed") },
    });
    expect(loopStore.get(workflow.id)).toMatchObject({
      status: "active",
      workflow: { currentState: "review", transitionSeq: 1 },
    });
  });

  it("E9 exposes administrative pause as distinct from semantic transition settlement", () => {
    const { loopStore, workflow } = setup();
    const before = loopStore.get(workflow.id)!;
    const paused = loopStore.pause(workflow.id)!;

    expect(paused).toMatchObject({
      status: "paused",
      workflow: {
        currentState: before.workflow?.currentState,
        transitionSeq: before.workflow?.transitionSeq,
      },
    });
    expect(paused.workflow?.lastTransition).toBeUndefined();
    expect(loopStore.resume(workflow.id)).toMatchObject({ status: "active" });
  });
});
