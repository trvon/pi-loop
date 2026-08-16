import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatLastTransitionLines } from "../loop-format.js";
import type { LoopEntry, Trigger, WorkflowDefinition, WorkflowRuntimeActor } from "../types.js";
import { renderToolCall, renderToolResult, toolArg } from "../ui/tool-renderer.js";
import { getActiveWorkflowStateLoop, getWorkflowOutcomeAvailability, validateWorkflowDefinition, type WorkflowTransitionFailure } from "../workflow-reducer.js";
import { textResult } from "./tool-result.js";

interface WorkflowStoreLike {
  get(id: string): LoopEntry | undefined;
  create(trigger: Trigger, prompt: string, opts: {
    recurring: boolean;
    maxFires?: number;
    dynamic?: Partial<NonNullable<LoopEntry["dynamic"]>>;
    workflow?: WorkflowDefinition;
    actor?: WorkflowRuntimeActor;
  }): LoopEntry;
  pause(id: string): LoopEntry | undefined;
  resume(id: string): LoopEntry | undefined;
  transitionWorkflow(
    id: string,
    input: { outcome: string; evidence?: string; actor?: WorkflowRuntimeActor },
    expected?: { currentState: string; transitionSeq: number; activeExecutionId?: string },
  ): {
    entry?: LoopEntry;
    applied: boolean;
    error?: string;
    failure?: WorkflowTransitionFailure;
    terminal?: "completed" | "paused";
  };
  claimWorkflowExecution(
    id: string,
    actor: WorkflowRuntimeActor,
    leaseSeconds?: number,
  ): { entry?: LoopEntry; claimed: boolean; error?: string };
}

interface TriggerSystemLike {
  add(entry: LoopEntry): void;
  remove(id: string): void;
}

export interface WorkflowToolsOptions {
  pi: ExtensionAPI;
  getStore: () => WorkflowStoreLike;
  getTriggerSystem: () => TriggerSystemLike;
  getActor: () => WorkflowRuntimeActor | undefined;
  updateWidget: () => void;
  onDynamicLoopActivated?: (entry: LoopEntry) => void;
}

function parseWorkflowDefinition(input: string): { definition?: WorkflowDefinition; error?: string } {
  try {
    const parsed = JSON.parse(input) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { error: "Workflow definition must be a JSON object" };
    const definition = parsed as WorkflowDefinition;
    const validationError = validateWorkflowDefinition(definition);
    return validationError ? { error: validationError } : { definition };
  } catch {
    return { error: "Workflow definition must be valid JSON" };
  }
}

const WORKFLOW_DEFINITION_EXAMPLE =
  '{"version":1,"initialState":"collect","states":{"collect":{"prompt":"Collect evidence.","on":{"ready":"publish"}},"publish":{"prompt":"Publish the result.","terminal":"completed"}}}';

function workflowDefaultMaxFires(definition: WorkflowDefinition): number {
  const loopBudget = Object.values(definition.states).reduce((total, state) => total + (state.loop?.maxFires ?? 0), 0);
  return loopBudget > 0 ? loopBudget : 30;
}

function stateLoopStartsImmediately(entry: LoopEntry): boolean {
  return Boolean(entry.workflow && getActiveWorkflowStateLoop(entry.workflow)?.startImmediately);
}

function formatWorkflowDefinitionError(error: string | undefined): string {
  return `Workflow definition rejected: ${error ?? "unknown validation error"}\nRequired fields: version: 1, initialState, and states.\nExample definition:\n${WORKFLOW_DEFINITION_EXAMPLE}\nNext: correct the JSON and call WorkflowCreate again.`;
}

export function formatWorkflowSummary(entry: LoopEntry, heading: string, failure?: WorkflowTransitionFailure): string {
  const workflow = entry.workflow!;
  const state = workflow.definition.states[workflow.currentState];
  const availability = getWorkflowOutcomeAvailability(workflow);
  const attempt = workflow.attemptsByState[workflow.currentState] ?? 1;
  const attemptLabel = state?.maxAttempts ? `${attempt}/${state.maxAttempts}` : String(attempt);
  let message = `${heading}\nGoal: ${entry.prompt}\nCurrent state: ${workflow.currentState}\nAttempt: ${attemptLabel}`;
  if (workflow.lastTransition) message += `\n${formatLastTransitionLines(workflow.lastTransition).join("\n")}`;
  if (state?.prompt) message += `\nInstruction: ${state.prompt}`;
  const execution = workflow.activeExecution;
  if (execution) {
    const lease = execution.lease;
    message += `\nActive workflow work: ${execution.subject} (${execution.id})`;
    message += lease ? `\nLease: active until ${new Date(lease.expiresAt).toISOString()}` : "\nLease: unowned; claim it before continuing.";
  } else if (state?.task) {
    message += "\nWorkflow work: missing; this workflow needs recovery.";
  } else {
    message += "\nWorkflow work: none configured for this state.";
  }
  if (workflow.waitingMonitor) return `${message}\nWaiting on monitor #${workflow.waitingMonitor.monitorId}.`;
  const unavailable = availability.unavailable.sort((left, right) => Number(right.outcome === failure?.outcome) - Number(left.outcome === failure?.outcome));
  if (unavailable.length > 0) message += `\nUnavailable outcomes: ${unavailable.map((item) => `${item.outcome} — ${item.targetState} exhausted ${item.maxAttempts} attempt(s)`).join("; ")}.`;
  if (state?.terminal) return `${message}\nTerminal: ${state.terminal}`;
  if (availability.available.length === 0 && unavailable.length === 0) {
    return `${message}\nNeeds attention: this state declares no outcomes ("on"). Add on: {outcome: targetState} to advance it.`;
  }
  if (availability.available.length === 0) return `${message}\nBlocked: all declared outcomes are unavailable.`;
  return `${message}\nChoose outcome: ${availability.available.join(", ")}\nNext: WorkflowTransition({ id: "${entry.id}", outcome: "${availability.available[0]}", evidence: "..." })`;
}

export function registerWorkflowTools(options: WorkflowToolsOptions): void {
  const { pi, getStore, getTriggerSystem, getActor, updateWidget, onDynamicLoopActivated } = options;

  pi.registerTool({
    name: "WorkflowCreate",
    label: "WorkflowCreate",
    renderCall: renderToolCall("Workflow", (args) => `create · ${String(toolArg(args, "goal") ?? "workflow").slice(0, 56)}`),
    renderResult: renderToolResult,
    description: "Create a task-driven workflow for named phases and outcomes. State work is embedded atomically in the workflow controller. Definition schema: {version:1, initialState, states:{stateId:{prompt, on:{outcome:targetState}, task?:{subject,description}, maxAttempts?, loop?:{schedule,maxFires?,startImmediately?}, terminal?}}}. Declare state work with task:{subject,description}; terminal is \"completed\" or \"paused\".",
    promptGuidelines: [
      "Use WorkflowCreate for named phase/outcome flows, not flat backlogs.",
      "Give nonterminal states concise prompts and explicit outcomes.",
      "Declare state work with task:{subject,description}; use prompt for instructions.",
      "Workflow state work is controller-owned; do not call TaskClaim or TaskUpdate for it.",
      "Model rework as outcome cycles bounded by maxAttempts.",
    ],
    parameters: Type.Object({
      goal: Type.String({ description: "Overall workflow goal" }),
      definition: Type.String({ description: "Workflow definition JSON; see the tool description for the schema" }),
      maxFires: Type.Optional(Type.Integer({ description: "Maximum workflow wakes before automatic expiry (default: 30)", default: 30, minimum: 1 })),
    }),
    async execute(_toolCallId, params) {
      const parsed = parseWorkflowDefinition(params.definition);
      if (!parsed.definition) return textResult(formatWorkflowDefinitionError(parsed.error));
      const actor = getActor();
      const initial = parsed.definition.states[parsed.definition.initialState];
      if (initial?.task && !actor) return textResult("Workflow creation requires an active session runtime; retry after turn_start.");
      const entry = getStore().create({ type: "dynamic" }, params.goal, {
        recurring: true,
        maxFires: params.maxFires ?? workflowDefaultMaxFires(parsed.definition),
        dynamic: { goal: params.goal, state: parsed.definition.initialState, iteration: 0 },
        workflow: parsed.definition,
        actor,
      });
      getTriggerSystem().add(entry);
      updateWidget();
      if (!entry.workflow || !getActiveWorkflowStateLoop(entry.workflow) || stateLoopStartsImmediately(entry)) onDynamicLoopActivated?.(entry);
      return textResult(`${formatWorkflowSummary(entry, `Workflow #${entry.id} created — ${entry.status}`)}\nWake: ${entry.workflow && getActiveWorkflowStateLoop(entry.workflow) ? "scheduled from the active state cadence." : "the state instruction will be delivered when the agent becomes idle."}`);
    },
  });

  pi.registerTool({
    name: "WorkflowClaim",
    label: "WorkflowClaim",
    renderCall: renderToolCall("Workflow", (args) => `claim · #${String(toolArg(args, "id") ?? "?")}`),
    renderResult: renderToolResult,
    description: "Claim unowned workflow work, renew this runtime's lease, or take over an expired lease. Returns no bearer token.",
    promptGuidelines: [
      "Claim each newly entered task phase before work; reclaim after restart or lease expiry.",
      "A live lease owned by another runtime cannot be bypassed.",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "Workflow loop ID" }),
      leaseSeconds: Type.Optional(Type.Integer({ description: "Lease duration in seconds (default: 1800)", minimum: 60, maximum: 3600 })),
    }),
    async execute(_toolCallId, params) {
      const actor = getActor();
      if (!actor) return textResult("Workflow claim requires an active session runtime; retry after turn_start.");
      const result = getStore().claimWorkflowExecution(params.id, actor, params.leaseSeconds);
      if (!result.claimed || !result.entry) return textResult(`Workflow #${params.id} was not claimed\nReason: ${result.error ?? "unknown error"}`);
      const execution = result.entry.workflow?.activeExecution;
      return textResult(`Workflow #${params.id} lease active until ${execution?.lease ? new Date(execution.lease.expiresAt).toISOString() : "unknown"}\n${formatWorkflowSummary(result.entry, `Workflow #${params.id} — ${result.entry.status}`)}`);
    },
  });

  pi.registerTool({
    name: "WorkflowTransition",
    label: "WorkflowTransition",
    renderCall: renderToolCall("Workflow", (args) => `transition · #${String(toolArg(args, "id") ?? "?")} → ${String(toolArg(args, "outcome") ?? "?")}`),
    renderResult: renderToolResult,
    description: "Advance one declared workflow outcome. The controller authorizes the current runtime lease; it never accepts a claim token.",
    promptGuidelines: [
      "WorkflowTransition uses id, outcome, and optional evidence; claimId is invalid.",
      "Use an exact outcome; inspect LoopList for state and attempt count.",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "Workflow loop ID" }),
      outcome: Type.String({ description: "Declared outcome for the current workflow state" }),
      evidence: Type.Optional(Type.String({ description: "Concise evidence supporting this transition" })),
    }),
    async execute(_toolCallId, params) {
      const store = getStore();
      const current = store.get(params.id);
      const actor = getActor();
      const expected = current?.workflow ? {
        currentState: current.workflow.currentState,
        transitionSeq: current.workflow.transitionSeq,
        activeExecutionId: current.workflow.activeExecution?.id,
      } : undefined;
      const result = store.transitionWorkflow(params.id, { outcome: params.outcome, evidence: params.evidence, actor }, expected);
      if (!result.applied || !result.entry) {
        const entry = store.get(params.id);
        const error = result.error ?? "unknown transition error";
        return textResult(entry?.workflow
          ? `Workflow #${params.id} did not transition\nReason: ${error}\n${formatWorkflowSummary(entry, `Workflow #${params.id} remains — ${entry.status}`, result.failure)}`
          : `Workflow #${params.id} did not transition\nReason: ${error}`);
      }
      const entry = result.entry;
      getTriggerSystem().remove(entry.id);
      updateWidget();
      if (result.terminal === "completed") return textResult(`Workflow #${entry.id} completed and deleted\nFinal transition: ${entry.workflow?.lastTransition?.from ?? "?"} → ${entry.workflow?.currentState ?? "?"}`);
      if (result.terminal === "paused") return textResult(`Workflow #${entry.id} paused\nFinal state: ${entry.workflow?.currentState ?? "?"}`);
      const resumed = entry.status === "paused" ? store.resume(entry.id) ?? entry : entry;
      getTriggerSystem().add(resumed);
      if (stateLoopStartsImmediately(resumed)) onDynamicLoopActivated?.(resumed);
      return textResult(`Workflow #${resumed.id} advanced: ${resumed.workflow?.lastTransition?.from ?? "?"} → ${resumed.workflow?.currentState ?? "?"}\n${formatWorkflowSummary(resumed, `Workflow #${resumed.id} — ${resumed.status}`)}`);
    },
  });
}
