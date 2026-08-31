import { isValidCronExpression } from "./loop-parse.js";
import type {
  WorkflowDefinition,
  WorkflowStateDefinition,
  WorkflowStateLoopDefinition,
  WorkflowTaskDefinition,
} from "./types.js";

const MAX_WORKFLOW_DEFINITION_BYTES = 65_536;

const WORKFLOW_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RESERVED_WORKFLOW_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function validateWorkflowKey(key: string, kind: "state" | "outcome"): string | undefined {
  if (WORKFLOW_KEY_PATTERN.test(key) && !RESERVED_WORKFLOW_KEYS.has(key)) return undefined;
  return `Workflow ${kind} key "${key}" must match ${WORKFLOW_KEY_PATTERN.source} and cannot be reserved`;
}

function validateTask(stateId: string, task: WorkflowTaskDefinition | undefined): string | undefined {
  if (task === undefined) return undefined;
  if (!task || typeof task !== "object" || Array.isArray(task)) return `State "${stateId}" task must be an object`;
  if (typeof task.subject !== "string" || !task.subject.trim()) return `State "${stateId}" task requires a subject`;
  if (typeof task.description !== "string" || !task.description.trim()) {
    return `State "${stateId}" task requires a description`;
  }
  return undefined;
}

function validateLoop(stateId: string, loop: WorkflowStateLoopDefinition | undefined): string | undefined {
  if (loop === undefined) return undefined;
  if (!loop || typeof loop !== "object" || Array.isArray(loop)) return `State "${stateId}" loop must be an object`;
  if (typeof loop.schedule !== "string" || !isValidCronExpression(loop.schedule)) {
    return `State "${stateId}" loop schedule must be a valid 5-field cron expression`;
  }
  if (loop.maxFires !== undefined && (!Number.isInteger(loop.maxFires) || loop.maxFires < 1)) {
    return `State "${stateId}" loop maxFires must be a positive integer`;
  }
  if (loop.startImmediately !== undefined && typeof loop.startImmediately !== "boolean") {
    return `State "${stateId}" loop startImmediately must be a boolean`;
  }
  return undefined;
}

function validateTransitions(
  definition: WorkflowDefinition,
  stateId: string,
  state: WorkflowStateDefinition,
  allowUnboundedSelfLoops: boolean,
): string | undefined {
  if (state.on !== undefined && (typeof state.on !== "object" || Array.isArray(state.on))) {
    return `State "${stateId}" transitions must be an object`;
  }
  for (const [outcome, target] of Object.entries(state.on ?? {})) {
    const keyError = validateWorkflowKey(outcome, "outcome");
    if (keyError) return keyError;
    if (typeof target !== "string") return `Transition "${stateId}.${outcome}" target must be a state ID`;
    if (!Object.hasOwn(definition.states, target)) {
      return `Transition "${stateId}.${outcome}" targets unknown state "${target}"`;
    }
    if (!allowUnboundedSelfLoops && target === stateId && state.maxAttempts === undefined) {
      return `State "${stateId}" self-loop "${outcome}" requires maxAttempts`;
    }
  }
  return undefined;
}

function validateTerminal(stateId: string, state: WorkflowStateDefinition): string | undefined {
  if (state.terminal !== undefined && state.terminal !== "completed" && state.terminal !== "paused") {
    return `State "${stateId}" terminal must be "completed" or "paused"`;
  }
  if (!state.terminal) return undefined;
  if (state.on && Object.keys(state.on).length > 0) return `Terminal state "${stateId}" cannot declare transitions`;
  if (state.task) return `Terminal state "${stateId}" cannot declare task work`;
  if (state.loop) return `Terminal state "${stateId}" cannot declare a loop policy`;
  return undefined;
}

function validateState(
  definition: WorkflowDefinition,
  stateId: string,
  state: WorkflowStateDefinition,
  allowUnboundedSelfLoops: boolean,
): string | undefined {
  const keyError = validateWorkflowKey(stateId, "state");
  if (keyError) return keyError;
  if (!state || typeof state !== "object" || Array.isArray(state)) return `State "${stateId}" must be an object`;
  if (typeof state.prompt !== "string" || !state.prompt.trim()) return `State "${stateId}" requires a prompt`;
  if (state.maxAttempts !== undefined && (!Number.isInteger(state.maxAttempts) || state.maxAttempts < 1)) {
    return `State "${stateId}" maxAttempts must be a positive integer`;
  }
  return validateTerminal(stateId, state)
    ?? validateTask(stateId, state.task)
    ?? validateLoop(stateId, state.loop)
    ?? validateTransitions(definition, stateId, state, allowUnboundedSelfLoops);
}

function definitionBytes(definition: WorkflowDefinition): number {
  try {
    return Buffer.byteLength(JSON.stringify(definition), "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function validateWorkflowDefinition(
  definition: WorkflowDefinition,
  options: { allowUnboundedSelfLoops?: boolean } = {},
): string | undefined {
  if (definition?.version !== 1) return "Workflow version must be 1";
  if (!definition.states || typeof definition.states !== "object" || Array.isArray(definition.states)) {
    return "Workflow states must be an object";
  }
  if (definitionBytes(definition) > MAX_WORKFLOW_DEFINITION_BYTES) {
    return `Workflow definition exceeds ${MAX_WORKFLOW_DEFINITION_BYTES} UTF-8 bytes`;
  }
  if (!definition.initialState || !Object.hasOwn(definition.states, definition.initialState)) {
    return `Initial state "${definition.initialState}" is not defined`;
  }
  const initialKeyError = validateWorkflowKey(definition.initialState, "state");
  if (initialKeyError) return initialKeyError;
  if (definition.states[definition.initialState]?.terminal) {
    return `Initial state "${definition.initialState}" cannot be terminal`;
  }
  for (const [stateId, state] of Object.entries(definition.states)) {
    const error = validateState(definition, stateId, state, options.allowUnboundedSelfLoops === true);
    if (error) return error;
  }
  return undefined;
}
