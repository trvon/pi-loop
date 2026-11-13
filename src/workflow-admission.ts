import type { LoopStore } from "./store.js";
import type { LoopEntry, OrchestrationVerification, WorkflowRuntimeActor } from "./types.js";

export type WorkflowFactValue = string | number | boolean | null;
export type WorkflowClaimClass = "environmental" | "user_authority";
export type WorkflowObservationSource = "environmental" | "user_authority";
export type WorkflowObservationStatus = "observed" | "abstained" | "error";
const MAX_ADMISSION_PROVIDERS = 8;
const MAX_ADMISSION_OBSERVATIONS = 8;
const MAX_PROVIDER_ID_LENGTH = 64;
const MAX_SUBJECT_LENGTH = 256;
const MAX_FACT_LENGTH = 64;
const MAX_FACT_VALUE_STRING_LENGTH = 1_024;

export type WorkflowAdmissionDecisionKind =
  | "not_required"
  | "confirmed"
  | "contradicted"
  | "unresolved"
  | "requires_user_authority";

export interface WorkflowAdmissionContext {
  workflowId: string;
  currentState: string;
  transitionSeq: number;
  definitionRevision: number;
  activeExecutionId?: string;
  contextDigest: string;
}

export interface WorkflowBlockerClaim {
  class: WorkflowClaimClass;
  provider: string;
  subject: string;
  fact: string;
  expected: WorkflowFactValue;
}

export interface WorkflowAdmissionObservation {
  fact: string;
  actual: WorkflowFactValue;
  sourceClass: WorkflowObservationSource;
  provider: string;
  providerVersion: string;
  observedAt: number;
  expiresAt: number;
  context: WorkflowAdmissionContext;
  status: WorkflowObservationStatus;
}

export interface WorkflowAdmissionDecision {
  decision: WorkflowAdmissionDecisionKind;
  reason: string;
  providers: string[];
}

export interface WorkflowAdmissionProvider {
  id: string;
  sourceClass: WorkflowObservationSource;
  observe(input: {
    claim: WorkflowBlockerClaim;
    context: WorkflowAdmissionContext;
    now: number;
  }): Promise<WorkflowAdmissionObservation[]>;
}

interface WorkflowAdmissionStore {
  get(id: string): LoopEntry | undefined;
  transitionWorkflow: LoopStore["transitionWorkflow"];
}

export interface WorkflowAdmissionRequest {
  store: WorkflowAdmissionStore;
  workflowId: string;
  outcome: string;
  evidence?: string;
  actor?: WorkflowRuntimeActor;
  claim?: WorkflowBlockerClaim;
  contextDigest: string;
  providers: WorkflowAdmissionProvider[];
  now?: number | (() => number);
  isContextCurrent?: () => boolean;
  /** Runs a state's per-outcome check; absent means verified outcomes stay unresolved. */
  runVerify?: (command: string) => Promise<OrchestrationVerification>;
}

export interface WorkflowAdmissionResult {
  decision: WorkflowAdmissionDecision;
  transition?: ReturnType<LoopStore["transitionWorkflow"]>;
  /** Present when the outcome declared a check and it ran. */
  verification?: OrchestrationVerification;
  /** The outcome actually taken, when it differs from the requested one (onFail). */
  appliedOutcome?: string;
}

const VERIFY_PROVIDER = "verify";
const VERIFY_EVIDENCE_TAIL_CHARS = 1_500;

function workflowContext(entry: LoopEntry, contextDigest: string): WorkflowAdmissionContext | undefined {
  const workflow = entry.workflow;
  if (!workflow || !contextDigest.trim()) return undefined;
  return {
    workflowId: entry.id,
    currentState: workflow.currentState,
    transitionSeq: workflow.transitionSeq,
    definitionRevision: workflow.definitionRevision,
    activeExecutionId: workflow.activeExecution?.id,
    contextDigest,
  };
}

function sameContext(left: WorkflowAdmissionContext, right: WorkflowAdmissionContext): boolean {
  return left.workflowId === right.workflowId
    && left.currentState === right.currentState
    && left.transitionSeq === right.transitionSeq
    && left.definitionRevision === right.definitionRevision
    && left.activeExecutionId === right.activeExecutionId
    && left.contextDigest === right.contextDigest;
}

function validFactValue(value: WorkflowFactValue): boolean {
  return value === null
    || (typeof value === "string" && value.length <= MAX_FACT_VALUE_STRING_LENGTH)
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value));
}

function validClaim(claim: WorkflowBlockerClaim): boolean {
  return Boolean(claim.provider.trim()
    && claim.provider.length <= MAX_PROVIDER_ID_LENGTH
    && claim.subject.trim()
    && claim.subject.length <= MAX_SUBJECT_LENGTH
    && claim.fact.trim()
    && claim.fact.length <= MAX_FACT_LENGTH
    && validFactValue(claim.expected));
}

function validObservation(observation: WorkflowAdmissionObservation): boolean {
  return Boolean(observation.fact.trim()
    && observation.fact.length <= MAX_FACT_LENGTH
    && validFactValue(observation.actual)
    && observation.provider.trim()
    && observation.provider.length <= MAX_PROVIDER_ID_LENGTH
    && observation.providerVersion.trim()
    && observation.providerVersion.length <= MAX_PROVIDER_ID_LENGTH
    && Number.isFinite(observation.observedAt)
    && Number.isFinite(observation.expiresAt)
    && observation.observedAt <= observation.expiresAt);
}

export function reconcileWorkflowClaim(
  claim: WorkflowBlockerClaim,
  observations: WorkflowAdmissionObservation[],
  context: WorkflowAdmissionContext,
  now: number,
): WorkflowAdmissionDecision {
  if (!validClaim(claim) || !Number.isFinite(now)) {
    return { decision: "unresolved", reason: "invalid_claim", providers: [] };
  }
  const current = observations.filter((observation) => validObservation(observation)
    && observation.status === "observed"
    && observation.fact === claim.fact
    && observation.provider === claim.provider
    && observation.sourceClass === claim.class
    && observation.observedAt <= now
    && observation.expiresAt >= now
    && sameContext(observation.context, context));
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
    decision: Object.is(firstValue, claim.expected) ? "confirmed" : "contradicted",
    reason: "exact_value_comparison",
    providers: current.map((observation) => `${observation.provider}@${observation.providerVersion}`),
  };
}

function expectedState(context: WorkflowAdmissionContext) {
  return {
    currentState: context.currentState,
    transitionSeq: context.transitionSeq,
    definitionRevision: context.definitionRevision,
    activeExecutionId: context.activeExecutionId,
  };
}

function terminalPauseTarget(entry: LoopEntry, outcome: string): boolean {
  const workflow = entry.workflow;
  const state = workflow?.definition.states[workflow.currentState];
  const targetId = state?.on?.[outcome];
  return targetId !== undefined && workflow?.definition.states[targetId]?.terminal === "paused";
}

export async function admitWorkflowTransition(input: WorkflowAdmissionRequest): Promise<WorkflowAdmissionResult> {
  const entry = input.store.get(input.workflowId);
  const context = entry && workflowContext(entry, input.contextDigest);
  if (!entry?.workflow || !context) {
    return { decision: { decision: "unresolved", reason: "workflow_unavailable", providers: [] } };
  }
  const expected = expectedState(context);
  if (input.isContextCurrent && !input.isContextCurrent()) {
    return { decision: { decision: "unresolved", reason: "stale_runtime_context", providers: [] } };
  }
  const check = entry.workflow.definition.states[entry.workflow.currentState]?.verify?.[input.outcome];
  if (check) return admitVerifiedTransition(input, check, expected);
  if (!terminalPauseTarget(entry, input.outcome)) {
    return {
      decision: { decision: "not_required", reason: "ordinary_transition", providers: [] },
      transition: input.store.transitionWorkflow(input.workflowId, {
        outcome: input.outcome,
        evidence: input.evidence,
        actor: input.actor,
      }, expected),
    };
  }
  const claim = input.claim;
  if (!claim) {
    return { decision: { decision: "unresolved", reason: "claim_required", providers: [] } };
  }
  if (!validClaim(claim)) {
    return { decision: { decision: "unresolved", reason: "invalid_claim", providers: [] } };
  }
  const matchingProviders = input.providers.filter((provider) => provider.id === claim.provider
    && provider.sourceClass === claim.class).slice(0, MAX_ADMISSION_PROVIDERS);
  if (matchingProviders.length === 0) {
    return {
      decision: {
        decision: claim.class === "user_authority" ? "requires_user_authority" : "unresolved",
        reason: "provider_unavailable",
        providers: [],
      },
    };
  }

  const clock = typeof input.now === "function"
    ? input.now
    : input.now === undefined
      ? Date.now
      : () => input.now as number;
  const observationTime = clock();
  // Providers may block or inspect other runtimes, so observation must finish before the CAS-protected store mutation begins.
  const settled = await Promise.allSettled(matchingProviders.map((provider) => provider.observe({ claim, context, now: observationTime })));
  const observations: WorkflowAdmissionObservation[] = [];
  for (const result of settled) {
    if (result.status !== "fulfilled" || !Array.isArray(result.value)) continue;
    observations.push(...result.value.slice(0, MAX_ADMISSION_OBSERVATIONS - observations.length));
    if (observations.length === MAX_ADMISSION_OBSERVATIONS) break;
  }
  const decisionTime = clock();
  const decision = reconcileWorkflowClaim(claim, observations, context, decisionTime);
  if (decision.decision !== "confirmed") return { decision };
  if (input.isContextCurrent && !input.isContextCurrent()) {
    return { decision: { decision: "unresolved", reason: "stale_runtime_context", providers: decision.providers } };
  }

  return {
    decision,
    transition: input.store.transitionWorkflow(input.workflowId, {
      outcome: input.outcome,
      evidence: input.evidence,
      admission: {
        claimClass: claim.class,
        provider: claim.provider,
        subject: claim.subject,
        fact: claim.fact,
        expected: claim.expected,
        observations: decision.providers,
        decidedAt: decisionTime,
      },
      actor: input.actor,
    }, expected),
  };
}

async function admitVerifiedTransition(
  input: WorkflowAdmissionRequest,
  check: { command: string; onFail?: string },
  expected: ReturnType<typeof expectedState>,
): Promise<WorkflowAdmissionResult> {
  if (!input.runVerify) return { decision: { decision: "unresolved", reason: "verifier_unavailable", providers: [] } };
  const clock = typeof input.now === "function" ? input.now : input.now === undefined ? Date.now : () => input.now as number;
  let verification: OrchestrationVerification;
  const startedAt = clock();
  // The check runs before the CAS-protected store mutation, like any admission provider.
  try {
    verification = await input.runVerify(check.command);
  } catch (error) {
    verification = { passed: false, exitCode: null, durationMs: Math.max(0, clock() - startedAt), output: `verifier could not run: ${error instanceof Error ? error.message : String(error)}` };
  }
  const providers = [`${VERIFY_PROVIDER}@1`];
  if (input.isContextCurrent && !input.isContextCurrent()) {
    return { decision: { decision: "unresolved", reason: "stale_runtime_context", providers }, verification };
  }
  if (verification.passed) {
    return {
      decision: { decision: "confirmed", reason: "verify_passed", providers },
      verification,
      transition: input.store.transitionWorkflow(input.workflowId, {
        outcome: input.outcome,
        evidence: input.evidence,
        admission: {
          claimClass: "environmental",
          provider: VERIFY_PROVIDER,
          subject: check.command.slice(0, MAX_SUBJECT_LENGTH),
          fact: "exit_code",
          expected: 0,
          observations: providers,
          decidedAt: clock(),
        },
        actor: input.actor,
      }, expected),
    };
  }
  const decision: WorkflowAdmissionDecision = { decision: "contradicted", reason: "verify_failed", providers };
  if (!check.onFail) return { decision, verification };
  const tail = verification.output ? `\n${verification.output.slice(-VERIFY_EVIDENCE_TAIL_CHARS)}` : "";
  return {
    decision,
    verification,
    appliedOutcome: check.onFail,
    transition: input.store.transitionWorkflow(input.workflowId, {
      outcome: check.onFail,
      evidence: `verify failed for "${input.outcome}" (exit ${verification.exitCode ?? "killed"}): ${check.command}${tail}`,
      actor: input.actor,
    }, expected),
  };
}
