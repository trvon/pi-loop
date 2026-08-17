import type {
  WorkflowDefinition,
  WorkflowExecutionRecord,
  WorkflowRunState,
  WorkflowRuntimeActor,
  WorkflowStateLoopDefinition,
  WorkflowTerminalStatus,
  WorkflowTransitionRecord,
} from "./types.js";

export interface WorkflowTransitionInput {
  outcome: string;
  evidence?: string;
  actor?: WorkflowRuntimeActor;
}

export interface WorkflowTransitionFailure {
  code: "target_exhausted";
  outcome: string;
  targetState: string;
  maxAttempts: number;
}

export type WorkflowTransitionResult =
  | { applied: true; run: WorkflowRunState; terminal?: WorkflowTerminalStatus }
  | { applied: false; error: string; failure?: WorkflowTransitionFailure };

export interface WorkflowOutcomeAvailability {
  available: string[];
  unavailable: Array<{ outcome: string; targetState: string; maxAttempts: number }>;
}

export function getActiveWorkflowStateLoop(run: WorkflowRunState): WorkflowStateLoopDefinition | undefined {
  return run.definition.states[run.currentState]?.loop;
}

export function atWorkflowStateFireLimit(run: WorkflowRunState): boolean {
  const loop = getActiveWorkflowStateLoop(run);
  return loop?.maxFires !== undefined && (run.stateFireCounts?.[run.currentState] ?? 0) >= loop.maxFires;
}

export function getWorkflowOutcomeAvailability(run: WorkflowRunState): WorkflowOutcomeAvailability {
  const state = run.definition.states[run.currentState];
  const available: string[] = [];
  const unavailable: WorkflowOutcomeAvailability["unavailable"] = [];
  for (const [outcome, targetState] of Object.entries(state?.on ?? {})) {
    const target = run.definition.states[targetState];
    const nextAttempt = (run.attemptsByState[targetState] ?? 0) + 1;
    if (target?.maxAttempts !== undefined && nextAttempt > target.maxAttempts) {
      unavailable.push({ outcome, targetState, maxAttempts: target.maxAttempts });
    } else {
      available.push(outcome);
    }
  }
  return { available, unavailable };
}

function createLease(actor: WorkflowRuntimeActor | undefined, at: number) {
  if (!actor) return undefined;
  return {
    ownerSessionId: actor.sessionId,
    ownerRuntimeId: actor.runtimeId,
    acquiredAt: at,
    heartbeatAt: at,
    expiresAt: at + 30 * 60 * 1000,
    attempt: 1,
  };
}

function activateExecution(options: {
  stateId: string;
  transitionSeq: number;
  task: NonNullable<WorkflowDefinition["states"][string]["task"]>;
  at: number;
  actor?: WorkflowRuntimeActor;
}): WorkflowExecutionRecord {
  return {
    id: `${options.stateId}:${options.transitionSeq}`,
    stateId: options.stateId,
    transitionSeq: options.transitionSeq,
    subject: options.task.subject,
    description: options.task.description,
    status: "active",
    createdAt: options.at,
    updatedAt: options.at,
    lease: createLease(options.actor, options.at),
  };
}

export function createWorkflowRun(
  definition: WorkflowDefinition,
  at: number,
  actor?: WorkflowRuntimeActor,
): WorkflowRunState {
  const initial = definition.states[definition.initialState];
  return {
    definition,
    definitionRevision: 1,
    revisionHistory: [],
    currentState: definition.initialState,
    transitionSeq: 0,
    stateEnteredAt: at,
    attemptsByState: { [definition.initialState]: 1 },
    stateFireCounts: {},
    activeExecution: initial?.task
      ? activateExecution({ stateId: definition.initialState, transitionSeq: 0, task: initial.task, at, actor })
      : undefined,
  };
}

export function isTerminalWorkflowRun(run: WorkflowRunState | undefined): boolean {
  return Boolean(run?.definition.states[run.currentState]?.terminal);
}

function validateExecutionOwnership(
  run: WorkflowRunState,
  actor: WorkflowRuntimeActor | undefined,
  at: number,
): string | undefined {
  const current = run.definition.states[run.currentState];
  if (!current?.task) return undefined;
  const active = run.activeExecution;
  if (!active || active.stateId !== run.currentState || active.transitionSeq !== run.transitionSeq || active.status !== "active") {
    return "Workflow execution is missing or does not match the active state";
  }
  if (!active.lease) return "Workflow execution is unowned; claim it before transitioning";
  if (!actor) return "Workflow transition requires an active session runtime";
  if (active.lease.expiresAt <= at) return "Workflow execution lease expired; claim it before transitioning";
  if (active.lease.ownerSessionId !== actor.sessionId || active.lease.ownerRuntimeId !== actor.runtimeId) {
    return "Workflow execution is leased to another active runtime";
  }
  return undefined;
}

function resolveTarget(
  run: WorkflowRunState,
  outcome: string,
): { target?: string; terminal?: WorkflowTerminalStatus; error?: string; failure?: WorkflowTransitionFailure } {
  const current = run.definition.states[run.currentState];
  if (!current) return { error: `Current state "${run.currentState}" is not defined` };
  if (current.terminal) return { error: `Workflow is already ${current.terminal}` };
  const target = current.on?.[outcome];
  if (!target) return { error: `Outcome "${outcome}" is not allowed from state "${run.currentState}"` };
  const targetState = run.definition.states[target];
  if (!targetState) return { error: `Transition target "${target}" is not defined` };
  const nextAttempt = (run.attemptsByState[target] ?? 0) + 1;
  if (targetState.maxAttempts !== undefined && nextAttempt > targetState.maxAttempts) {
    return {
      error: `State "${target}" has exhausted its ${targetState.maxAttempts} attempt limit`,
      failure: {
        code: "target_exhausted",
        outcome,
        targetState: target,
        maxAttempts: targetState.maxAttempts,
      },
    };
  }
  return { target, terminal: targetState.terminal };
}

function settleExecution(
  execution: WorkflowExecutionRecord | undefined,
  evidence: string | undefined,
  at: number,
): WorkflowExecutionRecord | undefined {
  if (!execution) return undefined;
  return {
    ...execution,
    status: "completed",
    updatedAt: at,
    settledAt: at,
    evidence,
    lease: undefined,
  };
}

export function transitionWorkflowRun(
  run: WorkflowRunState,
  input: WorkflowTransitionInput,
  at: number,
): WorkflowTransitionResult {
  const ownershipError = validateExecutionOwnership(run, input.actor, at);
  if (ownershipError) return { applied: false, error: ownershipError };
  const resolved = resolveTarget(run, input.outcome);
  if (!resolved.target) return { applied: false, error: resolved.error ?? "Unknown workflow transition error", failure: resolved.failure };

  const target = resolved.target;
  const targetState = run.definition.states[target];
  if (!targetState) return { applied: false, error: `Transition target "${target}" is not defined` };
  const sequence = run.transitionSeq + 1;
  const settled = settleExecution(run.activeExecution, input.evidence, at);
  const destination = targetState.task && !targetState.terminal
    ? activateExecution({ stateId: target, transitionSeq: sequence, task: targetState.task, at })
    : undefined;
  const lastTransition: WorkflowTransitionRecord = {
    from: run.currentState,
    to: target,
    outcome: input.outcome,
    evidence: input.evidence,
    at,
    sequence,
  };
  const nextRun: WorkflowRunState = {
    ...run,
    currentState: target,
    transitionSeq: sequence,
    stateEnteredAt: at,
    attemptsByState: { ...run.attemptsByState, [target]: (run.attemptsByState[target] ?? 0) + 1 },
    stateFireCounts: run.stateFireCounts ?? {},
    activeExecution: destination,
    executionHistory: settled ? [...(run.executionHistory ?? []), settled] : run.executionHistory,
    waitingMonitor: undefined,
    lastTransition,
  };
  return { applied: true, run: nextRun, terminal: resolved.terminal };
}
