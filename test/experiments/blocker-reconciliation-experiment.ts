import { LoopStore } from "../../src/store.js";
import type { LoopEntry, WorkflowRuntimeActor } from "../../src/types.js";

export type ExperimentFactValue = string | number | boolean | null;
export type ExperimentClaimClass = "environmental" | "user_authority";
export type ExperimentObservationSource = "deterministic" | "user_authority";
export type ExperimentObservationStatus = "observed" | "abstained" | "error";
export type ExperimentDecisionKind = "confirmed" | "contradicted" | "unresolved" | "requires_user_authority";

export interface ExperimentWorkflowContext {
  workflowId: string;
  currentState: string;
  transitionSeq: number;
  definitionRevision: number;
  activeExecutionId?: string;
  contextDigest: string;
}

export interface ExperimentClaim {
  class: ExperimentClaimClass;
  fact: string;
  expected: ExperimentFactValue;
  context: ExperimentWorkflowContext;
}

export interface ExperimentObservation {
  fact: string;
  actual: ExperimentFactValue;
  sourceClass: ExperimentObservationSource;
  provider: string;
  providerVersion: string;
  observedAt: number;
  expiresAt: number;
  context: ExperimentWorkflowContext;
  status: ExperimentObservationStatus;
}

export interface ExperimentDecision {
  decision: ExperimentDecisionKind;
  reason: string;
  providers: string[];
}

interface WorkflowExpectedState {
  currentState: string;
  transitionSeq: number;
  definitionRevision: number;
  activeExecutionId?: string;
}

export type ExperimentPauseClass = "not_paused" | "semantic_terminal" | "nonsemantic_unattributed";

export interface ExperimentTransitionAttempt {
  store: LoopStore;
  workflowId: string;
  runtimeContextDigest: string;
  outcome: string;
  claim: ExperimentClaim;
  observations: ExperimentObservation[];
  now: number;
  actor?: WorkflowRuntimeActor;
  beforeCommit?: (expected: WorkflowExpectedState) => void;
}

export function classifyWorkflowPause(entry: LoopEntry): ExperimentPauseClass {
  if (entry.status !== "paused") return "not_paused";
  const workflow = entry.workflow;
  if (!workflow) return "nonsemantic_unattributed";
  const state = workflow.definition.states[workflow.currentState];
  const transition = workflow.lastTransition;
  return state?.terminal === "paused"
      && transition?.to === workflow.currentState
      && transition.sequence === workflow.transitionSeq
    ? "semantic_terminal"
    : "nonsemantic_unattributed";
}

export function contextFor(entry: LoopEntry, contextDigest: string): ExperimentWorkflowContext {
  if (!entry.workflow) throw new Error(`Loop #${entry.id} is not a workflow`);
  return {
    workflowId: entry.id,
    currentState: entry.workflow.currentState,
    transitionSeq: entry.workflow.transitionSeq,
    definitionRevision: entry.workflow.definitionRevision,
    activeExecutionId: entry.workflow.activeExecution?.id,
    contextDigest,
  };
}

function validContext(context: ExperimentWorkflowContext): boolean {
  return Boolean(context.workflowId.trim()
    && context.currentState.trim()
    && context.contextDigest.trim()
    && Number.isSafeInteger(context.transitionSeq)
    && context.transitionSeq >= 0
    && Number.isSafeInteger(context.definitionRevision)
    && context.definitionRevision >= 1);
}

function validObservation(observation: ExperimentObservation): boolean {
  return Boolean(observation.fact.trim()
    && observation.provider.trim()
    && observation.providerVersion.trim()
    && validContext(observation.context)
    && Number.isFinite(observation.observedAt)
    && Number.isFinite(observation.expiresAt)
    && observation.observedAt <= observation.expiresAt);
}

function sameContext(left: ExperimentWorkflowContext, right: ExperimentWorkflowContext): boolean {
  return left.workflowId === right.workflowId
    && left.currentState === right.currentState
    && left.transitionSeq === right.transitionSeq
    && left.definitionRevision === right.definitionRevision
    && left.activeExecutionId === right.activeExecutionId
    && left.contextDigest === right.contextDigest;
}

function currentObservations(
  claim: ExperimentClaim,
  observations: ExperimentObservation[],
  now: number,
): ExperimentObservation[] {
  const requiredSource: ExperimentObservationSource = claim.class === "user_authority"
    ? "user_authority"
    : "deterministic";
  return observations.filter((observation) => validObservation(observation)
    && observation.status === "observed"
    && observation.fact === claim.fact
    && observation.sourceClass === requiredSource
    && observation.observedAt <= now
    && observation.expiresAt >= now
    && sameContext(observation.context, claim.context));
}

export function reconcileClaim(
  claim: ExperimentClaim,
  observations: ExperimentObservation[],
  now: number,
): ExperimentDecision {
  if (!claim.fact.trim() || !validContext(claim.context) || !Number.isFinite(now)) {
    return { decision: "unresolved", reason: "invalid_claim", providers: [] };
  }
  const current = currentObservations(claim, observations, now);
  if (current.length === 0) {
    return {
      decision: claim.class === "user_authority" ? "requires_user_authority" : "unresolved",
      reason: "no_current_observation",
      providers: [],
    };
  }

  const firstValue = current[0]!.actual;
  if (current.some((observation) => !Object.is(observation.actual, firstValue))) {
    return {
      decision: "unresolved",
      reason: "conflicting_observations",
      providers: current.map((observation) => `${observation.provider}@${observation.providerVersion}`),
    };
  }

  return {
    decision: Object.is(current[0]?.actual, claim.expected) ? "confirmed" : "contradicted",
    reason: "exact_value_comparison",
    providers: current.map((observation) => `${observation.provider}@${observation.providerVersion}`),
  };
}

export function attemptClaimedTransition(input: ExperimentTransitionAttempt): {
  decision: ExperimentDecision;
  transition?: ReturnType<LoopStore["transitionWorkflow"]>;
} {
  const entry = input.store.get(input.workflowId);
  if (!entry?.workflow) {
    return {
      decision: { decision: "unresolved", reason: "workflow_unavailable", providers: [] },
    };
  }

  const currentContext = contextFor(entry, input.runtimeContextDigest);
  if (!sameContext(currentContext, input.claim.context)) {
    return {
      decision: { decision: "unresolved", reason: "stale_claim_context", providers: [] },
    };
  }

  const decision = reconcileClaim(input.claim, input.observations, input.now);
  if (decision.decision !== "confirmed") return { decision };

  const expected: WorkflowExpectedState = {
    currentState: entry.workflow.currentState,
    transitionSeq: entry.workflow.transitionSeq,
    definitionRevision: entry.workflow.definitionRevision,
    activeExecutionId: entry.workflow.activeExecution?.id,
  };
  input.beforeCommit?.(expected);
  const transition = input.store.transitionWorkflow(input.workflowId, {
    outcome: input.outcome,
    actor: input.actor,
    evidence: `experiment:${input.claim.class}:${input.claim.fact}:${decision.decision}`,
  }, expected);
  return { decision, transition };
}
