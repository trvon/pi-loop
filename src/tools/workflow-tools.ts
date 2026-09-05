import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatLastTransitionLines } from "../loop-format.js";
import type { LoopEntry, Trigger, WorkflowAdmissionRecord, WorkflowDefinition, WorkflowRevisionChange, WorkflowRevisionFailure, WorkflowRuntimeActor } from "../types.js";
import { renderToolCall, renderToolResult, toolArg } from "../ui/tool-renderer.js";
import { workflowAttemptLabel, workflowDisplayDetails, workflowLeaseLabel, workflowTimingSummaryLine } from "../ui/workflow-presentation.js";
import { admitWorkflowTransition, type WorkflowAdmissionProvider } from "../workflow-admission.js";
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
    case "workflow_paused":
      return "This pause cannot be bypassed by reissue; inspect its provenance and choose an explicit bounded recovery.";
    case "current_state_immutable":
      return "Use reissue_state to atomically replace active instructions, or revise only future states and outgoing transitions.";
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
    expiresIn?: string;
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
    input: { outcome: string; evidence?: string; admission?: WorkflowAdmissionRecord; actor?: WorkflowRuntimeActor },
    expected: { currentState: string; transitionSeq: number; definitionRevision: number; activeExecutionId?: string },
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
  getAdmissionContextDigest: () => string;
  getAdmissionProviders: () => WorkflowAdmissionProvider[];
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

const WorkflowFactValueSchema = Type.Union([Type.String({ maxLength: 1_024 }), Type.Number(), Type.Boolean(), Type.Null()]);
const WorkflowBlockerClaimSchema = Type.Object({
  class: Type.Union([Type.Literal("environmental"), Type.Literal("user_authority")]),
  provider: Type.String({ minLength: 1, maxLength: 64, description: "Provider ID (built-in: monitor)" }),
  subject: Type.String({ minLength: 1, maxLength: 256, description: "Provider subject or monitor ID" }),
  fact: Type.String({ minLength: 1, maxLength: 64, description: "Fact; monitor: status, exitCode, stopReason" }),
  expected: WorkflowFactValueSchema,
});

function workflowDefaultMaxFires(definition: WorkflowDefinition): number {
  let automaticFires = 0;
  let hasCadence = false;
  let hasUnboundedCadence = false;
  for (const state of Object.values(definition.states)) {
    if (state.terminal) continue;
    if (state.loop) {
      hasCadence = true;
      if (state.loop.maxFires === undefined) hasUnboundedCadence = true;
      else automaticFires += state.loop.maxFires;
      if (state.loop.startImmediately) automaticFires += state.maxAttempts ?? 1;
    } else {
      automaticFires += state.maxAttempts ?? 1;
    }
  }
  // Preserve the historical 30-wake allowance for ordinary-only workflows
  // and unbounded cadence while reserving capacity for every activation.
  return hasCadence ? Math.max(1, automaticFires + (hasUnboundedCadence ? 30 : 0)) : 30;
}

function stateLoopStartsImmediately(entry: LoopEntry): boolean {
  return Boolean(entry.workflow && getActiveWorkflowStateLoop(entry.workflow)?.startImmediately);
}

/** Ordinary phases wake immediately; cadenced states only when startImmediately is set. */
function stateShouldWakeImmediately(entry: LoopEntry): boolean {
  return !entry.workflow || !getActiveWorkflowStateLoop(entry.workflow) || stateLoopStartsImmediately(entry);
}

function workflowWakeDescription(entry: LoopEntry): string {
  if (entry.status === "paused") return "no next wake is scheduled while the controller is paused.";
  if (entry.workflow && getActiveWorkflowStateLoop(entry.workflow)) return "scheduled from the active state cadence.";
  return "the state instruction will be delivered when the agent becomes idle.";
}

function formatWorkflowDefinitionError(error: string | undefined): string {
  return `Workflow definition rejected: ${error ?? "unknown validation error"}\nRequired fields: version: 1, initialState, and states.\nExample definition:\n${WORKFLOW_DEFINITION_EXAMPLE}\nNext: correct the JSON and call WorkflowCreate again.`;
}

export function formatWorkflowSummary(entry: LoopEntry, heading: string, failure?: WorkflowTransitionFailure, now = Date.now()): string {
  const workflow = entry.workflow!;
  const state = workflow.definition.states[workflow.currentState];
  const availability = getWorkflowOutcomeAvailability(workflow);
  const attempt = workflow.attemptsByState[workflow.currentState] ?? 1;
  const attemptLabel = state?.maxAttempts ? `${attempt}/${state.maxAttempts}` : String(attempt);
  let message = `${heading}\nGoal: ${entry.prompt}\n${workflowTimingSummaryLine(entry, now)}\nDefinition revision: ${workflow.definitionRevision ?? 1}\nCurrent state: ${workflow.currentState}\nTransition sequence: ${workflow.transitionSeq}\nAttempt: ${attemptLabel}`;
  if (entry.pause) message += `\nPause cause: ${entry.pause.kind}${entry.pause.reason ? ` — ${entry.pause.reason}` : ""}`;
  if (workflow.lastTransition) message += `\n${formatLastTransitionLines(workflow.lastTransition).join("\n")}`;
  if (state?.prompt) message += `\nInstruction: ${state.prompt}`;
  const execution = workflow.activeExecution;
  if (execution) {
    const lease = execution.lease;
    message += `\nActive workflow work: ${execution.subject} (${execution.id})`;
    message += `\nLease: ${workflowLeaseLabel(entry, now)}${lease && lease.expiresAt > now ? "" : "; claim it before continuing."}`;
  } else if (state?.task) {
    message += "\nWorkflow work: missing; this workflow needs recovery.";
  } else {
    message += "\nWorkflow work: none configured for this state.";
  }
  if (workflow.waitingMonitor) return `${message}\nWaiting on monitor #${workflow.waitingMonitor.monitorId}.`;
  if (entry.status === "paused") {
    const next = entry.pause?.kind === "controller_limit"
      ? "Do not resume or repeat a self-transition. Leave a state-local cadence cap through an evidenced transition to a different state; a workflow-wide cap permits only a terminal transition."
      : "Resume the workflow explicitly before continuing; transitions do not bypass pauses.";
    return `${message}\nController paused. ${next}`;
  }
  if (failure?.code === "unbounded_self_loop") {
    return `${message}\nUnsafe self-loop: ${failure.outcome} → ${failure.targetState} has no attempt bound. Use WorkflowRevise to add maxAttempts or redirect the outcome before retrying.`;
  }
  const unavailable = availability.unavailable.sort((left, right) => Number(right.outcome === failure?.outcome) - Number(left.outcome === failure?.outcome));
  if (unavailable.length > 0) {
    message += `\nUnavailable outcomes: ${unavailable.map((item) => "reason" in item
      ? `${item.outcome} — ${item.targetState} is an unbounded self-loop`
      : `${item.outcome} — ${item.targetState} exhausted ${item.maxAttempts} attempt(s)`).join("; ")}.`;
  }
  if (state?.terminal) return `${message}\nTerminal: ${state.terminal}`;
  const cas = `revision=${workflow.definitionRevision ?? 1}, state=${workflow.currentState}, transition sequence=${workflow.transitionSeq}`;
  if (availability.available.length === 0 && unavailable.length === 0) {
    return `${message}\nPlan gap: this state declares no outcomes ("on"). Use WorkflowRevise with the displayed revision/state/sequence (${cas}) to add a recovery route. Persist it, then continue through its transition and claim when actionable; do not stop or terminal-pause merely to report this gap.`;
  }
  if (availability.available.length === 0) {
    return `${message}\nRoute gap: all declared outcomes are unavailable. If actionable work remains, use WorkflowRevise with the displayed revision/state/sequence (${cas}) to add a bounded recovery route, then continue through its transition and claim. Do not fabricate an outcome or stop merely to report the gap.`;
  }
  const outcomes = availability.available.join(", ");
  if (execution && (!execution.lease || execution.lease.expiresAt <= now)) {
    return `${message}\nChoose outcome: ${outcomes}\nNext: WorkflowClaim({ id: "${entry.id}" }), then complete the work and call WorkflowTransition({ id: "${entry.id}", outcome: "${availability.available[0]}", evidence: "..." })`;
  }
  return `${message}\nChoose outcome: ${outcomes}\nNext: WorkflowTransition({ id: "${entry.id}", outcome: "${availability.available[0]}", evidence: "..." })`;
}

export function registerWorkflowTools(options: WorkflowToolsOptions): void {
  const {
    pi,
    getStore,
    getTriggerSystem,
    getActor,
    getAdmissionContextDigest,
    getAdmissionProviders,
    updateWidget,
    onDynamicLoopActivated,
  } = options;

  pi.registerTool({
    name: "WorkflowCreate",
    label: "WorkflowCreate",
    renderCall: renderToolCall("Workflow", (args) => `create · ${String(toolArg(args, "goal") ?? "workflow").slice(0, 56)}`),
    renderResult: renderToolResult,
    description: "Create a durable named-state controller for one goal. Definition: {version:1,initialState,states:{id:{prompt,on,task?:{subject,description},maxAttempts?,loop?,terminal?}}}. State work is embedded atomically; terminal is completed or paused.",
    promptGuidelines: [
      "Use WorkflowCreate instead of TaskCreate when one goal has ordered phases, conditional outcomes, rework, or durable handoff—even if the user calls the phases tasks.",
      "Embed task work; every self-loop needs maxAttempts. Workflow work never uses TaskClaim/TaskUpdate.",
      "Persist in the correct owner: TaskUpdate for unfinished standalone tasks, LoopUpdate for dynamic loops, and WorkflowRevise or WorkflowTransition for workflow plan changes or completed phases.",
    ],
    parameters: Type.Object({
      goal: Type.String({ description: "Overall workflow goal" }),
      definition: Type.String({ description: "Workflow definition JSON; see the tool description for the schema" }),
      maxFires: Type.Optional(Type.Integer({ description: "Maximum workflow wakes before automatic expiry (default: 30)", default: 30, minimum: 1 })),
      expiresIn: Type.Optional(Type.String({ description: "Lifetime for this new workflow, e.g. 12h or 14d; overrides PI_LOOP_EXPIRES_IN" })),
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
      const store = getStore();
      let entry: LoopEntry;
      try {
        entry = store.create({ type: "dynamic" }, params.goal, {
          recurring: true,
          maxFires: params.maxFires ?? workflowDefaultMaxFires(parsed.definition),
          expiresIn: params.expiresIn,
          dynamic: { goal: params.goal, state: parsed.definition.initialState, iteration: 0 },
          workflow: parsed.definition,
          actor,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return textResult(message, {
          kind: "workflow", action: "create", tone: "error", summary: "Workflow was not created", expanded: [message],
        });
      }
      getTriggerSystem().add(entry);
      if (stateShouldWakeImmediately(entry)) onDynamicLoopActivated?.(entry);
      const current = store.get(entry.id) ?? entry;
      if (current.status !== "active") getTriggerSystem().remove(current.id);
      updateWidget();
      const wake = workflowWakeDescription(current);
      return textResult(
        `${formatWorkflowSummary(current, `Workflow #${current.id} created — ${current.status}`)}\nWake: ${wake}`,
        workflowDisplayDetails({
          entry: current,
          action: "create",
          tone: current.status === "paused" ? "warning" : "success",
          summary: `Workflow #${current.id} ${current.status} · ${current.workflow?.currentState ?? "unknown"} · attempt ${workflowAttemptLabel(current)}`,
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
    description: "Revise a workflow through typed CAS changes; reissue_state safely replaces active instructions.",
    promptGuidelines: [
      "Non-task WorkflowRevise needs no claim. Pass exact CAS; use WorkflowClaim only for unowned/expired task work.",
      "For stale current work use reissue_state; it histories old execution and wakes fresh work. For prerequisites use add_state + redirect_transition. Never park under ignored instructions. Never create standalone tasks.",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "Workflow loop ID" }),
      expectedRevision: Type.Integer({ description: "Definition revision reported by LoopList", minimum: 1 }),
      expectedState: Type.String({ description: "Current state reported by LoopList", minLength: 1 }),
      expectedTransitionSeq: Type.Integer({ description: "Transition sequence reported by LoopList", minimum: 0 }),
      reason: Type.String({ description: "Why this revision is required", minLength: 1, maxLength: 1000 }),
      changes: Type.Array(WorkflowRevisionChangeSchema, {
        description: "Typed atomic changes; reissue_state replaces current work",
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
        const current = getStore().get(params.id);
        const next = failure?.code === "workflow_paused" && current?.pause?.kind === "controller_limit"
          ? "The controller fire cap is exhausted; inspect it and create a new bounded workflow if work must continue. Resuming does not renew the cap."
          : revisionRecovery(failure?.code);
        const message = `Workflow #${params.id} was not revised\nCode: ${failure?.code ?? "unknown"}\nReason: ${reason}\nNext: ${next}`;
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
      const summary = result.summary;
      const reissued = summary.reissuedStates.length > 0;
      const activated = reissued && result.entry.status === "active";
      if (activated) {
        getTriggerSystem().remove(result.entry.id);
        getTriggerSystem().add(result.entry);
        onDynamicLoopActivated?.(result.entry);
      }
      const current = getStore().get(result.entry.id) ?? result.entry;
      if (activated && current.status !== "active") getTriggerSystem().remove(current.id);
      updateWidget();
      const lines = [
        `Workflow #${params.id} revised: revision ${params.expectedRevision} → ${current.workflow?.definitionRevision}`,
        `Reason: ${params.reason.trim()}`,
      ];
      if (summary.addedStates.length > 0) lines.push(`Added states: ${summary.addedStates.join(", ")}`);
      if (summary.revisedStates.length > 0) lines.push(`Revised state work: ${summary.revisedStates.join(", ")}`);
      if (summary.reissuedStates.length > 0) lines.push(`Reissued active state: ${summary.reissuedStates.join(", ")}`);
      if (summary.addedTransitions.length > 0) {
        lines.push(`Added edges: ${summary.addedTransitions.map((edge) => `${edge.from}.${edge.outcome} → ${edge.to}`).join("; ")}`);
      }
      if (summary.redirectedTransitions.length > 0) {
        lines.push(`Redirected edges: ${summary.redirectedTransitions.map((edge) => `${edge.from}.${edge.outcome}: ${edge.fromTarget} → ${edge.to}`).join("; ")}`);
      }
      const execution = current.workflow?.activeExecution;
      if (reissued) {
        lines.push(`Current execution replaced: ${current.workflow?.currentState}${execution ? ` (${execution.id})` : " (taskless)"}`);
        if (current.pause?.kind === "controller_limit") {
          lines.push("Controller limit reached during activation; do not resume it to renew the exhausted budget.");
        } else if (current.status === "paused") {
          lines.push(execution && !execution.lease
            ? `Next: WorkflowClaim({ id: "${current.id}" }), then resume through /loop to wake the fresh instruction.`
            : "Next: resume through /loop to wake the fresh instruction; the superseded prompt will not run.");
        } else {
          lines.push(execution && !execution.lease
            ? `Next: WorkflowClaim({ id: "${current.id}" }), then follow the fresh instruction.`
            : "Next: follow the fresh instruction; do not execute the superseded prompt.");
        }
      } else {
        lines.push(`Current execution preserved: ${current.workflow?.currentState}${execution ? ` (${execution.id})` : ""}`);
        lines.push("Next: complete the active work and transition through the revised outcome.");
      }
      return textResult(
        lines.join("\n"),
        workflowDisplayDetails({
          entry: current,
          action: "revise",
          tone: current.status === "paused" ? "warning" : "success",
          summary: `Workflow #${params.id} revised · r${params.expectedRevision} → r${current.workflow?.definitionRevision ?? "?"}`,
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
    description: "Advance a declared outcome; it never accepts a claim token. Paused terminal outcomes require trusted blocker admission outside LoopStore.",
    promptGuidelines: [
      "WorkflowTransition uses id, outcome, and optional evidence; paused terminal outcomes require a typed claim; claimId is invalid.",
      "Machine evidence cannot grant user authority. If no outcome fits, use WorkflowRevise; never fabricate an outcome or terminal pause.",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "Workflow loop ID" }),
      outcome: Type.String({ description: "Declared outcome for the current workflow state" }),
      evidence: Type.Optional(Type.String({ description: "Concise evidence supporting this transition" })),
      claim: Type.Optional(WorkflowBlockerClaimSchema),
    }),
    async execute(_toolCallId, params) {
      const store = getStore();
      const actor = getActor();
      const contextDigest = getAdmissionContextDigest();
      const admission = await admitWorkflowTransition({
        store,
        workflowId: params.id,
        outcome: params.outcome,
        evidence: params.evidence,
        actor,
        claim: params.claim,
        contextDigest,
        providers: getAdmissionProviders(),
        isContextCurrent: () => {
          const currentActor = getActor();
          return getStore() === store
            && getAdmissionContextDigest() === contextDigest
            && currentActor?.sessionId === actor?.sessionId
            && currentActor?.runtimeId === actor?.runtimeId;
        },
      });
      const result = admission.transition;
      if (!result) {
        const entry = store.get(params.id);
        const next = admission.decision.decision === "requires_user_authority"
          ? "Ask the user for the explicit decision and keep the workflow active; this runtime has no authority provider."
          : admission.decision.reason === "claim_required"
            ? "Retry with a typed claim backed by a trusted provider."
            : "Refresh the scoped evidence and retry; unresolved or contradicted claims never mutate workflow state.";
        const message = `Workflow #${params.id} did not transition\nAdmission: ${admission.decision.decision} (${admission.decision.reason})\nNext: ${next}`;
        return textResult(message, entry?.workflow
          ? workflowDisplayDetails({
              entry,
              action: "transition",
              tone: "error",
              summary: `Workflow #${params.id} transition admission rejected`,
              extra: [`Admission: ${admission.decision.decision} (${admission.decision.reason})`, `Next: ${next}`],
            })
          : { kind: "workflow", action: "transition", tone: "error", summary: `Workflow #${params.id} transition admission rejected`, expanded: message.split("\n").slice(1) });
      }
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
      if (entry.status === "active") {
        getTriggerSystem().add(entry);
        if (stateShouldWakeImmediately(entry)) onDynamicLoopActivated?.(entry);
      }
      const current = store.get(entry.id) ?? entry;
      if (current.status !== "active") getTriggerSystem().remove(current.id);
      updateWidget();
      const transition = `${current.workflow?.lastTransition?.from ?? "?"} → ${current.workflow?.currentState ?? "?"}`;
      return textResult(
        `Workflow #${current.id} advanced: ${transition}\n${formatWorkflowSummary(current, `Workflow #${current.id} — ${current.status}`)}`,
        workflowDisplayDetails({
          entry: current,
          action: "transition",
          tone: current.status === "paused" ? "warning" : "success",
          summary: `Workflow #${current.id} advanced · ${transition}`,
        }),
      );
    },
  });
}
