import { isValidCronExpression } from "./loop-parse.js";
import type {
  WorkflowDefinition,
  WorkflowExecutionRecord,
  WorkflowRunState,
  WorkflowRuntimeActor,
  WorkflowStateLoopDefinition,
  WorkflowTerminalStatus,
  WorkflowTransitionRecord,
} from "./types.js";

export type {
  WorkflowDefinition,
  WorkflowRunState,
  WorkflowStateDefinition,
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
    } else available.push(outcome);
  }
  return { available, unavailable };
}

export function validateWorkflowDefinition(definition: WorkflowDefinition): string | undefined {
  if (definition?.version !== 1) return "Workflow version must be 1";
  if (!definition.states || typeof definition.states !== "object") return "Workflow states must be an object";
  if (!definition.initialState || !definition.states[definition.initialState]) {
    return `Initial state "${definition.initialState}" is not defined`;
  }
  if (definition.states[definition.initialState]?.terminal) {
    return `Initial state "${definition.initialState}" cannot be terminal`;
  }

  for (const [stateId, state] of Object.entries(definition.states)) {
    if (!stateId) return "Workflow state IDs must be non-empty";
    if (!state || typeof state !== "object") return `State "${stateId}" must be an object`;
    if (typeof state.prompt !== "string") return `State "${stateId}" requires a prompt`;
    if (!state.prompt.trim()) return `State "${stateId}" requires a prompt`;
    if (state.on !== undefined && (typeof state.on !== "object" || Array.isArray(state.on))) {
      return `State "${stateId}" transitions must be an object`;
    }
    if (state.terminal && state.on && Object.keys(state.on).length > 0) {
      return `Terminal state "${stateId}" cannot declare transitions`;
    }
    if (state.maxAttempts !== undefined && (!Number.isInteger(state.maxAttempts) || state.maxAttempts < 1)) {
      return `State "${stateId}" maxAttempts must be a positive integer`;
    }
    if (state.loop !== undefined) {
      if (!state.loop || typeof state.loop !== "object" || Array.isArray(state.loop)) {
        return `State "${stateId}" loop must be an object`;
      }
      if (typeof state.loop.schedule !== "string" || !isValidCronExpression(state.loop.schedule)) {
        return `State "${stateId}" loop schedule must be a valid 5-field cron expression`;
      }
      if (state.loop.maxFires !== undefined && (!Number.isInteger(state.loop.maxFires) || state.loop.maxFires < 1)) {
        return `State "${stateId}" loop maxFires must be a positive integer`;
      }
      if (state.terminal) return `Terminal state "${stateId}" cannot declare a loop policy`;
    }
    for (const [outcome, target] of Object.entries(state.on ?? {})) {
      if (!outcome) return `State "${stateId}" has an empty outcome name`;
      if (typeof target !== "string") return `Transition "${stateId}.${outcome}" target must be a state ID`;
      if (!definition.states[target]) return `Transition "${stateId}.${outcome}" targets unknown state "${target}"`;
    }
  }

  return undefined;
}

export function createWorkflowRun(
  definition: WorkflowDefinition,
  at: number,
  actor?: WorkflowRuntimeActor,
): WorkflowRunState {
  const initial = definition.states[definition.initialState];
  const activeExecution = initial?.task
    ? {
        id: `${definition.initialState}:0`,
        stateId: definition.initialState,
        transitionSeq: 0,
        subject: initial.task.subject,
        description: initial.task.description,
        status: "active" as const,
        createdAt: at,
        updatedAt: at,
        lease: actor
          ? {
              ownerSessionId: actor.sessionId,
              ownerRuntimeId: actor.runtimeId,
              acquiredAt: at,
              heartbeatAt: at,
              expiresAt: at + 30 * 60 * 1000,
              attempt: 1,
            }
          : undefined,
      }
    : undefined;
  return {
    definition,
    currentState: definition.initialState,
    transitionSeq: 0,
    stateEnteredAt: at,
    attemptsByState: { [definition.initialState]: 1 },
    stateFireCounts: {},
    activeExecution,
  };
}

function activateExecution(
  stateId: string,
  transitionSeq: number,
  task: NonNullable<WorkflowDefinition["states"][string]["task"]>,
  actor: WorkflowRuntimeActor,
  at: number,
): WorkflowExecutionRecord {
  return {
    id: `${stateId}:${transitionSeq}`,
    stateId,
    transitionSeq,
    subject: task.subject,
    description: task.description,
    status: "active",
    createdAt: at,
    updatedAt: at,
    lease: {
      ownerSessionId: actor.sessionId,
      ownerRuntimeId: actor.runtimeId,
      acquiredAt: at,
      heartbeatAt: at,
      expiresAt: at + 30 * 60 * 1000,
      attempt: 1,
    },
  };
}

function actorOwnsLiveLease(execution: WorkflowExecutionRecord, actor: WorkflowRuntimeActor | undefined, at: number): boolean {
  const lease = execution.lease;
  return Boolean(
    actor
    && lease
    && lease.expiresAt > at
    && lease.ownerSessionId === actor.sessionId
    && lease.ownerRuntimeId === actor.runtimeId,
  );
}

export function isTerminalWorkflowRun(run: WorkflowRunState | undefined): boolean {
  return Boolean(run?.definition.states[run.currentState]?.terminal);
}

export function transitionWorkflowRun(
  run: WorkflowRunState,
  input: WorkflowTransitionInput,
  at: number,
): WorkflowTransitionResult {
  const current = run.definition.states[run.currentState];
  if (!current) return { applied: false, error: `Current state "${run.currentState}" is not defined` };
  if (current.terminal) return { applied: false, error: `Workflow is already ${current.terminal}` };
  if (current.task) {
    const active = run.activeExecution;
    if (!active || active.stateId !== run.currentState || active.transitionSeq !== run.transitionSeq || active.status !== "active") {
      return { applied: false, error: "Workflow execution is missing or does not match the active state" };
    }
    if (!active.lease) {
      return { applied: false, error: "Workflow execution is unowned; claim it before transitioning" };
    }
    if (!actorOwnsLiveLease(active, input.actor, at)) {
      return { applied: false, error: "Workflow execution is leased to another active runtime" };
    }
  }

  const target = current.on?.[input.outcome];
  if (!target) return { applied: false, error: `Outcome "${input.outcome}" is not allowed from state "${run.currentState}"` };

  const targetState = run.definition.states[target];
  if (!targetState) return { applied: false, error: `Transition target "${target}" is not defined` };

  const nextAttempt = (run.attemptsByState[target] ?? 0) + 1;
  if (targetState.maxAttempts !== undefined && nextAttempt > targetState.maxAttempts) {
    return {
      applied: false,
      error: `State "${target}" has exhausted its ${targetState.maxAttempts} attempt limit`,
      failure: {
        code: "target_exhausted",
        outcome: input.outcome,
        targetState: target,
        maxAttempts: targetState.maxAttempts,
      },
    };
  }

  const sequence = run.transitionSeq + 1;
  if (targetState.task && !targetState.terminal && !input.actor) {
    return { applied: false, error: "Workflow execution requires a runtime lease owner" };
  }
  const settledExecution = run.activeExecution
    ? {
        ...run.activeExecution,
        status: "completed" as const,
        updatedAt: at,
        settledAt: at,
        evidence: input.evidence,
        lease: undefined,
      }
    : undefined;
  const destinationExecution = targetState.task && !targetState.terminal && input.actor
    ? activateExecution(target, sequence, targetState.task, input.actor, at)
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
    attemptsByState: { ...run.attemptsByState, [target]: nextAttempt },
    stateFireCounts: run.stateFireCounts ?? {},
    activeExecution: destinationExecution,
    executionHistory: settledExecution ? [...(run.executionHistory ?? []), settledExecution] : run.executionHistory,
    waitingMonitor: undefined,
    lastTransition,
  };

  return { applied: true, run: nextRun, terminal: targetState.terminal };
}
