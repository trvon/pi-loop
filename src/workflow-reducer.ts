import type {
  WorkflowDefinition,
  WorkflowRunState,
  WorkflowTerminalStatus,
  WorkflowTransitionRecord,
} from "./types.js";

export type {
  WorkflowDefinition,
  WorkflowRunState,
  WorkflowStateDefinition,
  WorkflowTerminalStatus,
  WorkflowTransitionRecord,
} from "./types.js";

export interface WorkflowTransitionInput {
  outcome: string;
  evidence?: string;
  activeTaskId?: string;
}

export type WorkflowTransitionResult =
  | { applied: true; run: WorkflowRunState; terminal?: WorkflowTerminalStatus }
  | { applied: false; error: string };

export function validateWorkflowDefinition(definition: WorkflowDefinition): string | undefined {
  if (!definition || definition.version !== 1) return "Workflow version must be 1";
  if (!definition.states || typeof definition.states !== "object") return "Workflow states must be an object";
  if (!definition.initialState || !definition.states[definition.initialState]) {
    return `Initial state "${definition.initialState}" is not defined`;
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
    for (const [outcome, target] of Object.entries(state.on ?? {})) {
      if (!outcome) return `State "${stateId}" has an empty outcome name`;
      if (typeof target !== "string") return `Transition "${stateId}.${outcome}" target must be a state ID`;
      if (!definition.states[target]) return `Transition "${stateId}.${outcome}" targets unknown state "${target}"`;
    }
  }

  return undefined;
}

export function createWorkflowRun(definition: WorkflowDefinition, at: number): WorkflowRunState {
  return {
    definition,
    currentState: definition.initialState,
    transitionSeq: 0,
    stateEnteredAt: at,
    attemptsByState: { [definition.initialState]: 1 },
  };
}

export function transitionWorkflowRun(
  run: WorkflowRunState,
  input: WorkflowTransitionInput,
  at: number,
): WorkflowTransitionResult {
  const current = run.definition.states[run.currentState];
  if (!current) return { applied: false, error: `Current state "${run.currentState}" is not defined` };
  if (current.terminal) return { applied: false, error: `Workflow is already ${current.terminal}` };

  const target = current.on?.[input.outcome];
  if (!target) return { applied: false, error: `Outcome "${input.outcome}" is not allowed from state "${run.currentState}"` };

  const targetState = run.definition.states[target];
  if (!targetState) return { applied: false, error: `Transition target "${target}" is not defined` };

  const nextAttempt = (run.attemptsByState[target] ?? 0) + 1;
  if (targetState.maxAttempts !== undefined && nextAttempt > targetState.maxAttempts) {
    return { applied: false, error: `State "${target}" has exhausted its ${targetState.maxAttempts} attempt limit` };
  }

  const sequence = run.transitionSeq + 1;
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
    activeTaskId: input.activeTaskId,
    lastTransition,
  };

  return { applied: true, run: nextRun, terminal: targetState.terminal };
}
