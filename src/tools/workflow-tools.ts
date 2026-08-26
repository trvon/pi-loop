import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatLastTransitionLines } from "../loop-format.js";
import type { LoopEntry, Trigger, WorkflowDefinition, WorkflowRevisionChange, WorkflowRevisionFailure, WorkflowRuntimeActor } from "../types.js";
import { renderToolCall, renderToolResult, toolArg } from "../ui/tool-renderer.js";
import { workflowAttemptLabel, workflowDisplayDetails } from "../ui/workflow-presentation.js";
import { validateWorkflowDefinition } from "../workflow-definition.js";
import { getActiveWorkflowStateLoop, getWorkflowOutcomeAvailability, type WorkflowTransitionFailure } from "../workflow-reducer.js";
import type { WorkflowRevisionSummary } from "../workflow-revision.js";
import { WorkflowRevisionChangeSchema } from "../workflow-schema.js";
import { textResult } from "./tool-result.js";

function revisionRecovery(code: WorkflowRevisionFailure["code"] | undefined): string {
  switch (code) {
    case "revision_conflict":
    case "run_conflict":
      return "Inspect LoopList and re-author the revision against the current revision, state, and transition sequence.";
    case "execution_unowned":
    case "lease_expired":
      return "Call WorkflowClaim, then retry against the current workflow state.";
    case "lease_owned_elsewhere":
      return "The active runtime owns this phase; wait for handoff or inspect LoopList after its lease expires.";
    case "monitor_wait_active":
      return "Wait for the attached monitor to settle before revising the workflow.";
    case "current_state_immutable":
      return "Preserve current work; revise only future states or outgoing transitions.";
    case "revision_limit_reached":
    case "terminal_workflow":
      return "This workflow no longer accepts revisions; inspect LoopList before choosing a new controller.";
    case "actor_required":
      return "Retry from an active pi session so the runtime can authorize the revision.";
    case "loop_not_found":
    case "not_workflow":
    case "execution_missing":
      return "Inspect LoopList and choose an active workflow with matching execution state.";
    default:
      return "Correct the typed changes described above, preserve current work, and retry against the same CAS values.";
  }
}

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
  reviseWorkflow(
    id: string,
    input: {
      expectedRevision: number;
      expectedState: string;
      expectedTransitionSeq: number;
      reason: string;
      changes: WorkflowRevisionChange[];
    },
    actor?: WorkflowRuntimeActor,
  ): {
    entry?: LoopEntry;
    applied: boolean;
    error?: string;
    failure?: WorkflowRevisionFailure;
    summary?: WorkflowRevisionSummary;
  };
  transitionWorkflow(
    id: string,
    input: { outcome: string; evidence?: string; actor?: WorkflowRuntimeActor },
    expected?: { currentState: string; transitionSeq: number; definitionRevision: number; activeExecutionId?: string },
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

/** Ordinary phases wake immediately; cadenced states only when startImmediately is set. */
function stateShouldWakeImmediately(entry: LoopEntry): boolean {
  return !entry.workflow || !getActiveWorkflowStateLoop(entry.workflow) || stateLoopStartsImmediately(entry);
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
  let message = `${heading}\nGoal: ${entry.prompt}\nDefinition revision: ${workflow.definitionRevision ?? 1}\nCurrent state: ${workflow.currentState}\nTransition sequence: ${workflow.transitionSeq}\nAttempt: ${attemptLabel}`;
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
  const cas = `revision=${workflow.definitionRevision ?? 1}, state=${workflow.currentState}, transition sequence=${workflow.transitionSeq}`;
  if (availability.available.length === 0 && unavailable.length === 0) {
    return `${message}\nPlan gap: this state declares no outcomes ("on"). Use WorkflowRevise with the displayed revision/state/sequence (${cas}) to add a recovery route. Persist it, then continue through its transition and claim when actionable; do not stop or terminal-pause merely to report this gap.`;
  }
  if (availability.available.length === 0) {
    return `${message}\nRoute gap: all declared outcomes are unavailable. If actionable work remains, use WorkflowRevise with the displayed revision/state/sequence (${cas}) to add a bounded recovery route, then continue through its transition and claim. Do not fabricate an outcome or stop merely to report the gap.`;
  }
  const outcomes = availability.available.join(", ");
  if (execution && !execution.lease) {
    return `${message}\nChoose outcome: ${outcomes}\nNext: WorkflowClaim({ id: "${entry.id}" }), then complete the work and call WorkflowTransition({ id: "${entry.id}", outcome: "${availability.available[0]}", evidence: "..." })`;
  }
  return `${message}\nChoose outcome: ${outcomes}\nNext: WorkflowTransition({ id: "${entry.id}", outcome: "${availability.available[0]}", evidence: "..." })`;
}

export function registerWorkflowTools(options: WorkflowToolsOptions): void {
  const { pi, getStore, getTriggerSystem, getActor, updateWidget, onDynamicLoopActivated } = options;

  pi.registerTool({
    name: "WorkflowCreate",
    label: "WorkflowCreate",
    renderCall: renderToolCall("Workflow", (args) => `create · ${String(toolArg(args, "goal") ?? "workflow").slice(0, 56)}`),
    renderResult: renderToolResult,
    description: "Create a durable named-state controller for one goal. Definition: {version:1,initialState,states:{id:{prompt,on,task?:{subject,description},maxAttempts?,loop?,terminal?}}}. State work is embedded atomically; terminal is completed or paused.",
    promptGuidelines: [
      "Use WorkflowCreate instead of TaskCreate when one goal has ordered phases, conditional outcomes, rework, or durable handoff—even if the user calls the phases tasks.",
      "Embed phase work as task:{subject,description}; use concise outcomes and maxAttempts. Workflow work never uses TaskClaim/TaskUpdate.",
      "Persist in the correct owner: TaskUpdate for unfinished standalone tasks, LoopUpdate for dynamic loops, and WorkflowRevise or WorkflowTransition for workflow plan changes or completed phases.",
    ],
    parameters: Type.Object({
      goal: Type.String({ description: "Overall workflow goal" }),
      definition: Type.String({ description: "Workflow definition JSON; see the tool description for the schema" }),
      maxFires: Type.Optional(Type.Integer({ description: "Maximum workflow wakes before automatic expiry (default: 30)", default: 30, minimum: 1 })),
    }),
    async execute(_toolCallId, params) {
      const parsed = parseWorkflowDefinition(params.definition);
      if (!parsed.definition) {
        const message = formatWorkflowDefinitionError(parsed.error);
        return textResult(message, {
          kind: "workflow", action: "create", tone: "error", summary: "Workflow was not created", expanded: [message],
        });
      }
      const actor = getActor();
      const initial = parsed.definition.states[parsed.definition.initialState];
      if (initial?.task && !actor) {
        const message = "Workflow creation requires an active session runtime; retry after turn_start.";
        return textResult(message, {
          kind: "workflow", action: "create", tone: "error", summary: "Workflow runtime unavailable", expanded: [message],
        });
      }
      const entry = getStore().create({ type: "dynamic" }, params.goal, {
        recurring: true,
        maxFires: params.maxFires ?? workflowDefaultMaxFires(parsed.definition),
        dynamic: { goal: params.goal, state: parsed.definition.initialState, iteration: 0 },
        workflow: parsed.definition,
        actor,
      });
      getTriggerSystem().add(entry);
      updateWidget();
      if (stateShouldWakeImmediately(entry)) onDynamicLoopActivated?.(entry);
      const wake = entry.workflow && getActiveWorkflowStateLoop(entry.workflow)
        ? "scheduled from the active state cadence."
        : "the state instruction will be delivered when the agent becomes idle.";
      return textResult(
        `${formatWorkflowSummary(entry, `Workflow #${entry.id} created — ${entry.status}`)}\nWake: ${wake}`,
        workflowDisplayDetails({
          entry,
          action: "create",
          tone: "success",
          summary: `Workflow #${entry.id} active · ${entry.workflow?.currentState ?? "unknown"} · attempt ${workflowAttemptLabel(entry)}`,
          extra: [`Wake: ${wake}`],
        }),
      );
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
      if (!actor) {
        const message = "Workflow claim requires an active session runtime; retry after turn_start.";
        return textResult(message, {
          kind: "workflow", action: "claim", tone: "error", summary: `Workflow #${params.id} claim rejected`, expanded: [message],
        });
      }
      const result = getStore().claimWorkflowExecution(params.id, actor, params.leaseSeconds);
      if (!result.claimed || !result.entry) {
        const reason = result.error ?? "unknown error";
        return textResult(`Workflow #${params.id} was not claimed\nReason: ${reason}`, {
          kind: "workflow", action: "claim", tone: "error", summary: `Workflow #${params.id} claim rejected`, expanded: [reason],
        });
      }
      const execution = result.entry.workflow?.activeExecution;
      return textResult(
        `Workflow #${params.id} lease active until ${execution?.lease ? new Date(execution.lease.expiresAt).toISOString() : "unknown"}\n${formatWorkflowSummary(result.entry, `Workflow #${params.id} — ${result.entry.status}`)}`,
        workflowDisplayDetails({
          entry: result.entry,
          action: "claim",
          tone: "success",
          summary: `Workflow #${params.id} lease active · ${result.entry.workflow?.currentState ?? "unknown"}`,
        }),
      );
    },
  });

  pi.registerTool({
    name: "WorkflowRevise",
    label: "WorkflowRevise",
    renderCall: renderToolCall("Workflow", (args) => `revise · #${String(toolArg(args, "id") ?? "?")} · r${String(toolArg(args, "expectedRevision") ?? "?")}`),
    renderResult: renderToolResult,
    description: "Revise a running workflow with typed additive changes while preserving current work and history.",
    promptGuidelines: [
      "Non-task WorkflowRevise needs no claim. Use exact revision/state/sequence; claim only unowned/expired active task work.",
      "Persist actionable plan gaps with WorkflowRevise, then continue through the normal transition/claim; add_state + redirect_transition inserts prerequisites. Never create standalone tasks for workflow work.",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "Workflow loop ID" }),
      expectedRevision: Type.Integer({ description: "Definition revision reported by LoopList", minimum: 1 }),
      expectedState: Type.String({ description: "Current state reported by LoopList", minLength: 1 }),
      expectedTransitionSeq: Type.Integer({ description: "Transition sequence reported by LoopList", minimum: 0 }),
      reason: Type.String({ description: "Why this revision is required", minLength: 1, maxLength: 1000 }),
      changes: Type.Array(WorkflowRevisionChangeSchema, {
        description: "Atomic typed changes: add_state, revise_state, add_transition, or redirect_transition",
        minItems: 1,
        maxItems: 64,
      }),
    }),
    async execute(_toolCallId, params) {
      const result = getStore().reviseWorkflow(params.id, {
        expectedRevision: params.expectedRevision,
        expectedState: params.expectedState,
        expectedTransitionSeq: params.expectedTransitionSeq,
        reason: params.reason,
        changes: params.changes,
      }, getActor());
      if (!result.applied || !result.entry || !result.summary) {
        const failure = result.failure;
        const reason = result.error ?? "unknown revision error";
        const next = revisionRecovery(failure?.code);
        const message = `Workflow #${params.id} was not revised\nCode: ${failure?.code ?? "unknown"}\nReason: ${reason}\nNext: ${next}`;
        const current = getStore().get(params.id);
        return textResult(message, current?.workflow
          ? workflowDisplayDetails({
              entry: current,
              action: "revise",
              tone: "error",
              summary: `Workflow #${params.id} revision rejected`,
              extra: [`Reason: ${reason}`, `Next: ${next}`],
            })
          : { kind: "workflow", action: "revise", tone: "error", summary: `Workflow #${params.id} revision rejected`, expanded: [`Reason: ${reason}`, `Next: ${next}`] });
      }
      updateWidget();
      const summary = result.summary;
      const lines = [
        `Workflow #${params.id} revised: revision ${params.expectedRevision} → ${result.entry.workflow?.definitionRevision}`,
        `Reason: ${params.reason.trim()}`,
      ];
      if (summary.addedStates.length > 0) lines.push(`Added states: ${summary.addedStates.join(", ")}`);
      if (summary.revisedStates.length > 0) lines.push(`Revised state work: ${summary.revisedStates.join(", ")}`);
      if (summary.addedTransitions.length > 0) {
        lines.push(`Added edges: ${summary.addedTransitions.map((edge) => `${edge.from}.${edge.outcome} → ${edge.to}`).join("; ")}`);
      }
      if (summary.redirectedTransitions.length > 0) {
        lines.push(`Redirected edges: ${summary.redirectedTransitions.map((edge) => `${edge.from}.${edge.outcome}: ${edge.fromTarget} → ${edge.to}`).join("; ")}`);
      }
      const execution = result.entry.workflow?.activeExecution;
      lines.push(`Current execution preserved: ${result.entry.workflow?.currentState}${execution ? ` (${execution.id})` : ""}`);
      lines.push("Next: complete the active work and transition through the revised outcome.");
      return textResult(
        lines.join("\n"),
        workflowDisplayDetails({
          entry: result.entry,
          action: "revise",
          tone: "success",
          summary: `Workflow #${params.id} revised · r${params.expectedRevision} → r${result.entry.workflow?.definitionRevision ?? "?"}`,
          extra: lines.slice(1),
        }),
      );
    },
  });

  pi.registerTool({
    name: "WorkflowTransition",
    label: "WorkflowTransition",
    renderCall: renderToolCall("Workflow", (args) => `transition · #${String(toolArg(args, "id") ?? "?")} → ${String(toolArg(args, "outcome") ?? "?")}`),
    renderResult: renderToolResult,
    description: "Advance one declared workflow outcome. The controller authorizes the current runtime lease; it never accepts a claim token.",
    promptGuidelines: [
      "WorkflowTransition uses id, outcome, and optional evidence; claimId is invalid. Outcome must be available and declared; inspect LoopList first.",
      "If no outcome fits or the plan changed, use WorkflowRevise first—never fabricate an outcome or terminal-pause merely to report progress.",
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
        definitionRevision: current.workflow.definitionRevision,
        activeExecutionId: current.workflow.activeExecution?.id,
      } : undefined;
      const result = store.transitionWorkflow(params.id, { outcome: params.outcome, evidence: params.evidence, actor }, expected);
      if (!result.applied || !result.entry) {
        const entry = store.get(params.id);
        const error = result.error ?? "unknown transition error";
        const message = entry?.workflow
          ? `Workflow #${params.id} did not transition\nReason: ${error}\n${formatWorkflowSummary(entry, `Workflow #${params.id} remains — ${entry.status}`, result.failure)}`
          : `Workflow #${params.id} did not transition\nReason: ${error}`;
        return textResult(message, entry?.workflow
          ? workflowDisplayDetails({
              entry,
              action: "transition",
              tone: "error",
              summary: `Workflow #${params.id} transition rejected`,
              extra: [`Reason: ${error}`],
            })
          : { kind: "workflow", action: "transition", tone: "error", summary: `Workflow #${params.id} transition rejected`, expanded: [`Reason: ${error}`] });
      }
      const entry = result.entry;
      getTriggerSystem().remove(entry.id);
      updateWidget();
      if (result.terminal === "completed") {
        const transition = `${entry.workflow?.lastTransition?.from ?? "?"} → ${entry.workflow?.currentState ?? "?"}`;
        return textResult(
          `Workflow #${entry.id} completed and deleted\nFinal transition: ${transition}`,
          workflowDisplayDetails({
            entry,
            action: "transition",
            tone: "success",
            summary: `Workflow #${entry.id} completed · ${transition}`,
          }),
        );
      }
      if (result.terminal === "paused") {
        return textResult(
          `Workflow #${entry.id} paused\nFinal state: ${entry.workflow?.currentState ?? "?"}`,
          workflowDisplayDetails({
            entry,
            action: "transition",
            tone: "warning",
            summary: `Workflow #${entry.id} paused · ${entry.workflow?.currentState ?? "unknown"}`,
          }),
        );
      }
      const resumed = entry.status === "paused" ? store.resume(entry.id) ?? entry : entry;
      getTriggerSystem().add(resumed);
      if (stateShouldWakeImmediately(resumed)) onDynamicLoopActivated?.(resumed);
      const transition = `${resumed.workflow?.lastTransition?.from ?? "?"} → ${resumed.workflow?.currentState ?? "?"}`;
      return textResult(
        `Workflow #${resumed.id} advanced: ${transition}\n${formatWorkflowSummary(resumed, `Workflow #${resumed.id} — ${resumed.status}`)}`,
        workflowDisplayDetails({
          entry: resumed,
          action: "transition",
          tone: "success",
          summary: `Workflow #${resumed.id} advanced · ${transition}`,
        }),
      );
    },
  });
}
