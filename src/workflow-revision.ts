import { Check } from "typebox/value";
import type {
  WorkflowDefinition,
  WorkflowDefinitionRevision,
  WorkflowRevisionChange,
  WorkflowRevisionFailure,
  WorkflowRunState,
  WorkflowRuntimeActor,
  WorkflowStateDefinition,
} from "./types.js";
import { validateWorkflowDefinition } from "./workflow-definition.js";
import { WorkflowDefinitionRevisionSchema, WorkflowRevisionChangeSchema } from "./workflow-schema.js";

export const MAX_WORKFLOW_REVISIONS = 32;
const MAX_WORKFLOW_REVISION_CHANGES = 64;

export interface WorkflowRevisionInput {
  expectedRevision: number;
  expectedState: string;
  expectedTransitionSeq: number;
  reason: string;
  changes: WorkflowRevisionChange[];
}

export interface AuthorizedWorkflowRevisionInput extends WorkflowRevisionInput {
  actor: WorkflowRuntimeActor;
}

export interface WorkflowRevisionSummary {
  addedStates: string[];
  revisedStates: string[];
  addedTransitions: Array<{ from: string; outcome: string; to: string }>;
  redirectedTransitions: Array<{ from: string; outcome: string; fromTarget: string; to: string }>;
}

export type WorkflowRevisionResult =
  | { applied: true; run: WorkflowRunState; summary: WorkflowRevisionSummary }
  | { applied: false; error: string; failure: WorkflowRevisionFailure };

type RevisionRejection = Extract<WorkflowRevisionResult, { applied: false }>;

type AddStateChange = Extract<WorkflowRevisionChange, { op: "add_state" }>;
type ReviseStateChange = Extract<WorkflowRevisionChange, { op: "revise_state" }>;
type AddTransitionChange = Extract<WorkflowRevisionChange, { op: "add_transition" }>;
type RedirectTransitionChange = Extract<WorkflowRevisionChange, { op: "redirect_transition" }>;

function rejected(
  code: WorkflowRevisionFailure["code"],
  message: string,
  details: Omit<WorkflowRevisionFailure, "code" | "message"> = {},
): RevisionRejection {
  return { applied: false, error: message, failure: { code, message, ...details } };
}

export function validatePersistedWorkflowRevision(
  revision: WorkflowDefinitionRevision,
  expectedRevision: number,
): string | undefined {
  if (!Check(WorkflowDefinitionRevisionSchema, revision)) return "history record is invalid";
  if (revision.revision !== expectedRevision) return "history is not contiguous";
  const definitionError = validateWorkflowDefinition(revision.definition);
  return definitionError ? `history definition is invalid: ${definitionError}` : undefined;
}

function pathExists(
  definition: WorkflowDefinition,
  start: string,
  predicate: (stateId: string, state: WorkflowStateDefinition) => boolean,
): boolean {
  const queue = [start];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const stateId = queue.shift();
    if (stateId === undefined || visited.has(stateId)) continue;
    visited.add(stateId);
    const state = definition.states[stateId];
    if (!state) continue;
    if (predicate(stateId, state)) return true;
    queue.push(...Object.values(state.on ?? {}));
  }
  return false;
}

function validatePreconditions(run: WorkflowRunState, input: AuthorizedWorkflowRevisionInput): RevisionRejection | undefined {
  const currentRevision = run.definitionRevision ?? 1;
  const revisionHistory = run.revisionHistory ?? [];
  if (input.expectedRevision !== currentRevision) {
    return rejected(
      "revision_conflict",
      `Workflow revision conflict: expected revision ${input.expectedRevision}, current revision ${currentRevision}.`,
      { expectedRevision: input.expectedRevision, currentRevision },
    );
  }
  if (input.expectedState !== run.currentState || input.expectedTransitionSeq !== run.transitionSeq) {
    return rejected(
      "run_conflict",
      `Workflow run changed: expected ${input.expectedState}@${input.expectedTransitionSeq}, current ${run.currentState}@${run.transitionSeq}.`,
      {
        expectedState: input.expectedState,
        currentState: run.currentState,
        expectedTransitionSeq: input.expectedTransitionSeq,
        currentTransitionSeq: run.transitionSeq,
      },
    );
  }
  if (run.definition.states[run.currentState]?.terminal) {
    return rejected("terminal_workflow", "Terminal workflow cannot be revised.");
  }
  if (run.waitingMonitor) {
    return rejected("monitor_wait_active", `Workflow is waiting on monitor #${run.waitingMonitor.monitorId}; revise after the wait clears.`);
  }
  if (currentRevision >= MAX_WORKFLOW_REVISIONS) {
    return rejected("revision_limit_reached", `Workflow has reached the ${MAX_WORKFLOW_REVISIONS}-revision limit.`);
  }
  if (revisionHistory.length + 1 !== currentRevision) {
    return rejected("graph_invalid", "Workflow revision history is inconsistent with its current revision.");
  }
  return undefined;
}

function authorize(run: WorkflowRunState, actor: WorkflowRuntimeActor, at: number): RevisionRejection | undefined {
  const current = run.definition.states[run.currentState];
  if (!current?.task) return undefined;
  const active = run.activeExecution;
  if (!active || active.stateId !== run.currentState || active.transitionSeq !== run.transitionSeq || active.status !== "active") {
    return rejected("execution_missing", "Workflow execution is missing or does not match the active state.");
  }
  if (!active.lease) return rejected("execution_unowned", "Workflow execution is unowned; call WorkflowClaim before revising.");
  if (active.lease.expiresAt <= at) {
    return rejected("lease_expired", "Workflow execution lease expired; call WorkflowClaim before revising.");
  }
  if (active.lease.ownerSessionId !== actor.sessionId || active.lease.ownerRuntimeId !== actor.runtimeId) {
    return rejected("lease_owned_elsewhere", "Workflow execution is leased to another active runtime.");
  }
  return undefined;
}

function validateChangeIdentity(
  change: WorkflowRevisionChange,
  stateChanges: Set<string>,
  edgeChanges: Set<string>,
): RevisionRejection | undefined {
  if (change.op === "add_state" || change.op === "revise_state") {
    if (stateChanges.has(change.stateId)) {
      return rejected("invalid_patch", `Workflow revision changes state "${change.stateId}" more than once.`);
    }
    stateChanges.add(change.stateId);
    return undefined;
  }
  if (change.op === "add_transition" || change.op === "redirect_transition") {
    const edge = `${change.from}\u0000${change.outcome}`;
    if (edgeChanges.has(edge)) {
      return rejected("invalid_patch", `Workflow revision changes transition "${change.from}.${change.outcome}" more than once.`);
    }
    edgeChanges.add(edge);
    return undefined;
  }
  return undefined;
}

function validateChangeSet(changes: WorkflowRevisionChange[]): RevisionRejection | undefined {
  if (!Array.isArray(changes) || changes.length < 1 || changes.length > MAX_WORKFLOW_REVISION_CHANGES) {
    return rejected("invalid_patch", `Workflow revision requires 1-${MAX_WORKFLOW_REVISION_CHANGES} changes.`);
  }
  const stateChanges = new Set<string>();
  const edgeChanges = new Set<string>();
  for (const change of changes) {
    if (!Check(WorkflowRevisionChangeSchema, change)) {
      return rejected("invalid_patch", "Workflow revision contains an invalid typed change.");
    }
    const error = validateChangeIdentity(change, stateChanges, edgeChanges);
    if (error) return error;
  }
  return undefined;
}

function addState(
  definition: WorkflowDefinition,
  change: AddStateChange,
  summary: WorkflowRevisionSummary,
): RevisionRejection | undefined {
  if (Object.hasOwn(definition.states, change.stateId)) {
    return rejected("state_conflict", `Workflow state "${change.stateId}" already exists.`, { stateId: change.stateId });
  }
  definition.states[change.stateId] = structuredClone(change.state);
  summary.addedStates.push(change.stateId);
  return undefined;
}

function validateRevisedLimits(run: WorkflowRunState, change: ReviseStateChange): RevisionRejection | undefined {
  if (change.maxAttempts !== undefined && change.maxAttempts <= (run.attemptsByState[change.stateId] ?? 0)) {
    return rejected("invalid_patch", `State "${change.stateId}" maxAttempts must exceed its existing attempt count.`, {
      stateId: change.stateId,
    });
  }
  if (change.loop?.maxFires !== undefined && change.loop.maxFires <= (run.stateFireCounts[change.stateId] ?? 0)) {
    return rejected("invalid_patch", `State "${change.stateId}" loop maxFires must exceed its existing fire count.`, {
      stateId: change.stateId,
    });
  }
  return undefined;
}

function validateStateRevision(
  run: WorkflowRunState,
  state: WorkflowStateDefinition | undefined,
  change: ReviseStateChange,
): RevisionRejection | undefined {
  if (!state) return rejected("state_conflict", `Workflow state "${change.stateId}" does not exist.`, { stateId: change.stateId });
  if (change.stateId === run.currentState) {
    return rejected("current_state_immutable", `State "${change.stateId}" is active; its work definition cannot change during this execution.`, {
      stateId: change.stateId,
    });
  }
  const fields = ["prompt", "task", "loop", "maxAttempts"].filter((field) => Object.hasOwn(change, field));
  if (fields.length === 0) return rejected("invalid_patch", `revise_state "${change.stateId}" has no changes.`, { stateId: change.stateId });
  const removesField = (Object.hasOwn(change, "prompt") && change.prompt === undefined)
    || (Object.hasOwn(change, "task") && change.task === undefined)
    || (Object.hasOwn(change, "loop") && change.loop === undefined)
    || (Object.hasOwn(change, "maxAttempts") && change.maxAttempts === undefined);
  if (removesField) {
    return rejected("invalid_patch", `revise_state "${change.stateId}" cannot remove state fields.`, { stateId: change.stateId });
  }
  return validateRevisedLimits(run, change);
}

function reviseState(
  run: WorkflowRunState,
  definition: WorkflowDefinition,
  change: ReviseStateChange,
  summary: WorkflowRevisionSummary,
): RevisionRejection | undefined {
  const state = definition.states[change.stateId];
  const validationError = validateStateRevision(run, state, change);
  if (validationError) return validationError;
  if (!state) return rejected("state_conflict", `Workflow state "${change.stateId}" does not exist.`, { stateId: change.stateId });

  const revised: WorkflowStateDefinition = { ...state };
  if (change.prompt !== undefined) revised.prompt = change.prompt;
  if (change.task !== undefined) revised.task = structuredClone(change.task);
  if (change.loop !== undefined) revised.loop = structuredClone(change.loop);
  if (change.maxAttempts !== undefined) revised.maxAttempts = change.maxAttempts;
  if (JSON.stringify(revised) === JSON.stringify(state)) {
    return rejected("invalid_patch", `revise_state "${change.stateId}" is a no-op.`, { stateId: change.stateId });
  }
  definition.states[change.stateId] = revised;
  summary.revisedStates.push(change.stateId);
  return undefined;
}

function applyStateChanges(
  run: WorkflowRunState,
  definition: WorkflowDefinition,
  changes: WorkflowRevisionChange[],
  summary: WorkflowRevisionSummary,
): RevisionRejection | undefined {
  const additions = changes.filter((change): change is AddStateChange => change.op === "add_state");
  for (const change of additions) {
    const error = addState(definition, change, summary);
    if (error) return error;
  }
  const revisions = changes.filter((change): change is ReviseStateChange => change.op === "revise_state");
  for (const change of revisions) {
    const error = reviseState(run, definition, change, summary);
    if (error) return error;
  }
  return undefined;
}

function edgeContext(
  definition: WorkflowDefinition,
  from: string,
  to: string,
): { source: WorkflowStateDefinition; transitions: Record<string, string> } | RevisionRejection {
  const source = definition.states[from];
  if (!source) return rejected("edge_conflict", `Workflow transition source "${from}" does not exist.`, { stateId: from });
  if (source.terminal) return rejected("edge_conflict", `Terminal state "${from}" cannot declare transitions.`, { stateId: from });
  if (!Object.hasOwn(definition.states, to)) {
    return rejected("edge_conflict", `Workflow transition target "${to}" does not exist.`, { stateId: to });
  }
  return { source, transitions: { ...source.on } };
}

function addTransition(
  definition: WorkflowDefinition,
  change: AddTransitionChange,
  summary: WorkflowRevisionSummary,
): RevisionRejection | undefined {
  const context = edgeContext(definition, change.from, change.to);
  if ("applied" in context) return context;
  const { source, transitions } = context;
  if (Object.hasOwn(transitions, change.outcome)) {
    return rejected("edge_conflict", `Transition "${change.from}.${change.outcome}" already exists.`);
  }
  transitions[change.outcome] = change.to;
  definition.states[change.from] = { ...source, on: transitions };
  summary.addedTransitions.push({ from: change.from, outcome: change.outcome, to: change.to });
  return undefined;
}

function redirectTransition(
  definition: WorkflowDefinition,
  change: RedirectTransitionChange,
  summary: WorkflowRevisionSummary,
): RevisionRejection | undefined {
  const context = edgeContext(definition, change.from, change.to);
  if ("applied" in context) return context;
  const { source, transitions } = context;
  const currentTarget = transitions[change.outcome];
  if (currentTarget !== change.expectedTo) {
    return rejected(
      "edge_conflict",
      `Transition "${change.from}.${change.outcome}" expected target "${change.expectedTo}" but found "${currentTarget ?? "missing"}".`,
    );
  }
  if (change.to === change.expectedTo) return rejected("invalid_patch", `Redirect "${change.from}.${change.outcome}" is a no-op.`);
  transitions[change.outcome] = change.to;
  definition.states[change.from] = { ...source, on: transitions };
  summary.redirectedTransitions.push({
    from: change.from,
    outcome: change.outcome,
    fromTarget: change.expectedTo,
    to: change.to,
  });
  return undefined;
}

function applyEdgeChanges(
  definition: WorkflowDefinition,
  changes: WorkflowRevisionChange[],
  summary: WorkflowRevisionSummary,
): RevisionRejection | undefined {
  for (const change of changes) {
    let error: RevisionRejection | undefined;
    if (change.op === "add_transition") error = addTransition(definition, change, summary);
    if (change.op === "redirect_transition") error = redirectTransition(definition, change, summary);
    if (error) return error;
  }
  return undefined;
}

function validateGraph(
  run: WorkflowRunState,
  definition: WorkflowDefinition,
  summary: WorkflowRevisionSummary,
): RevisionRejection | undefined {
  const definitionError = validateWorkflowDefinition(definition);
  if (definitionError) {
    const code = definitionError.includes("exceeds") ? "definition_too_large" : "graph_invalid";
    return rejected(code, `Revised workflow definition rejected: ${definitionError}.`);
  }
  const priorStates = new Set(Object.keys(run.definition.states));
  for (const stateId of summary.addedStates) {
    if (!pathExists(definition, run.currentState, (candidate) => candidate === stateId)) {
      return rejected("graph_invalid", `New state "${stateId}" is not reachable from current state "${run.currentState}".`, { stateId });
    }
    const rejoins = pathExists(
      definition,
      stateId,
      (candidate, state) => state.terminal !== undefined || (candidate !== stateId && priorStates.has(candidate)),
    );
    if (!rejoins) return rejected("graph_invalid", `New state "${stateId}" does not rejoin prior workflow work or a terminal state.`, { stateId });
  }
  for (const edge of summary.redirectedTransitions) {
    if (!pathExists(definition, edge.to, (candidate) => candidate === edge.fromTarget)) {
      return rejected(
        "dependency_not_preserved",
        `Redirect "${edge.from}.${edge.outcome}" must retain a path to prior target "${edge.fromTarget}".`,
      );
    }
  }
  return undefined;
}

export function reviseWorkflowRun(
  run: WorkflowRunState,
  input: AuthorizedWorkflowRevisionInput,
  at: number,
): WorkflowRevisionResult {
  const preconditionError = validatePreconditions(run, input);
  if (preconditionError) return preconditionError;
  const actor = input.actor;
  if (!actor) return rejected("actor_required", "Workflow revision requires an active session runtime.");
  const authorizationError = authorize(run, actor, at);
  if (authorizationError) return authorizationError;

  const reason = input.reason.trim();
  if (!reason || reason.length > 1000) return rejected("invalid_patch", "Workflow revision reason must contain 1-1000 characters.");
  const changeError = validateChangeSet(input.changes);
  if (changeError) return changeError;

  const definition = structuredClone(run.definition);
  const changes = structuredClone(input.changes);
  const summary: WorkflowRevisionSummary = {
    addedStates: [],
    revisedStates: [],
    addedTransitions: [],
    redirectedTransitions: [],
  };
  const stateError = applyStateChanges(run, definition, changes, summary);
  if (stateError) return stateError;
  const edgeError = applyEdgeChanges(definition, changes, summary);
  if (edgeError) return edgeError;
  const graphError = validateGraph(run, definition, summary);
  if (graphError) return graphError;
  if (JSON.stringify(definition) === JSON.stringify(run.definition)) return rejected("invalid_patch", "Workflow revision is a no-op.");

  const currentRevision = run.definitionRevision ?? 1;
  return {
    applied: true,
    run: {
      ...run,
      definition,
      definitionRevision: currentRevision + 1,
      revisionHistory: [
        ...(run.revisionHistory ?? []),
        {
          revision: currentRevision,
          definition: structuredClone(run.definition),
          reason,
          supersededAt: at,
          supersededBy: structuredClone(actor),
          changes,
        },
      ],
    },
    summary,
  };
}
