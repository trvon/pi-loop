import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatLastTransitionLines } from "../loop-format.js";
import type { LoopEntry, Trigger, WorkflowDefinition } from "../types.js";
import { renderToolCall, renderToolResult, toolArg } from "../ui/tool-renderer.js";
import { getActiveWorkflowStateLoop, getWorkflowOutcomeAvailability, transitionWorkflowRun, validateWorkflowDefinition, type WorkflowTransitionFailure } from "../workflow-reducer.js";
import { textResult } from "./tool-result.js";

interface WorkflowStoreLike {
  get(id: string): LoopEntry | undefined;
  create(trigger: Trigger, prompt: string, opts: {
    recurring: boolean;
    maxFires?: number;
    dynamic?: Partial<NonNullable<LoopEntry["dynamic"]>>;
    workflow?: WorkflowDefinition;
  }): LoopEntry;
  pause(id: string): LoopEntry | undefined;
  resume(id: string): LoopEntry | undefined;
  transitionWorkflow(
    id: string,
    input: { outcome: string; evidence?: string; activeTaskId?: string },
    expected?: { currentState: string; transitionSeq: number; activeTaskId?: string },
  ): {
    entry?: LoopEntry;
    applied: boolean;
    error?: string;
    failure?: WorkflowTransitionFailure;
    terminal?: "completed" | "paused";
  };
  setWorkflowActiveTask(
    id: string,
    taskId?: string,
    expected?: { currentState: string; transitionSeq: number; activeTaskId?: string },
  ): LoopEntry | undefined;
  delete(id: string): boolean;
}

interface TriggerSystemLike {
  add(entry: LoopEntry): void;
  remove(id: string): void;
}

export interface WorkflowToolsOptions {
  pi: ExtensionAPI;
  getStore: () => WorkflowStoreLike;
  getTriggerSystem: () => TriggerSystemLike;
  updateWidget: () => void;
  onDynamicLoopActivated?: (entry: LoopEntry) => void;
  isTaskSystemReady: () => boolean;
  createWorkflowTask?: (entry: LoopEntry) => Promise<string | undefined>;
  completeWorkflowTask?: (taskId: string, claimId?: string) => Promise<boolean>;
  closeWorkflowTask?: (taskId: string, claimId?: string) => Promise<boolean>;
}

function parseWorkflowDefinition(input: string): { definition?: WorkflowDefinition; error?: string } {
  try {
    const parsed = JSON.parse(input) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { error: "Workflow definition must be a JSON object" };
    }
    const definition = parsed as WorkflowDefinition;
    const validationError = validateWorkflowDefinition(definition);
    return validationError ? { error: validationError } : { definition };
  } catch {
    return { error: "Workflow definition must be valid JSON" };
  }
}

const WORKFLOW_DEFINITION_EXAMPLE =
  '{"version":1,"initialState":"collect","states":{"collect":{"prompt":"Collect evidence.","loop":{"schedule":"0 7 * * *","maxFires":10},"on":{"ready":"publish"}},"publish":{"prompt":"Publish the result.","terminal":"completed"}}}';

function workflowDefaultMaxFires(definition: WorkflowDefinition): number {
  const loopBudget = Object.values(definition.states)
    .reduce((total, state) => total + (state.loop?.maxFires ?? 0), 0);
  return loopBudget > 0 ? loopBudget : 30;
}

function stateLoopStartsImmediately(entry: LoopEntry): boolean {
  return Boolean(entry.workflow && getActiveWorkflowStateLoop(entry.workflow)?.startImmediately);
}

function formatWorkflowDefinitionError(error: string | undefined): string {
  return `Workflow definition rejected: ${error ?? "unknown validation error"}\n` +
    "Required fields: version: 1, initialState, and states.\n" +
    `Example definition:\n${WORKFLOW_DEFINITION_EXAMPLE}\n` +
    "Next: correct the JSON and call WorkflowCreate again.";
}

export function formatWorkflowSummary(entry: LoopEntry, heading: string, failure?: WorkflowTransitionFailure): string {
  const workflow = entry.workflow!;
  const state = workflow.definition.states[workflow.currentState];
  const outcomeEntries = Object.entries(state?.on ?? {});
  const availability = getWorkflowOutcomeAvailability(workflow);
  const unavailable = [...availability.unavailable].sort((left, right) => {
    if (left.outcome === failure?.outcome) return -1;
    if (right.outcome === failure?.outcome) return 1;
    return 0;
  });
  const outcomes = availability.available;
  const attempt = workflow.attemptsByState[workflow.currentState] ?? 1;
  const attemptLabel = state?.maxAttempts ? `${attempt}/${state.maxAttempts}` : String(attempt);
  let message = `${heading}\nGoal: ${entry.prompt}\nCurrent state: ${workflow.currentState}\nAttempt: ${attemptLabel}`;
  if (workflow.lastTransition) message += `\n${formatLastTransitionLines(workflow.lastTransition).join("\n")}`;
  if (state?.prompt) message += `\nInstruction: ${state.prompt}`;
  if (workflow.waitingMonitor) {
    message += `\nWaiting on monitor #${workflow.waitingMonitor.monitorId}. Its terminal outcome will resume this state; do not poll or call LoopUpdate.`;
  }
  if (state?.loop && !workflow.waitingMonitor) {
    const stateFires = workflow.stateFireCounts?.[workflow.currentState] ?? 0;
    const controllerFires = entry.fireCount ?? 0;
    message += `\nState cadence: ${state.loop.schedule} · state fires: ${stateFires}/${state.loop.maxFires ?? "unbounded"} · controller fires: ${controllerFires}/${entry.maxFires ?? "unbounded"}`;
  }
  if (workflow.activeTaskId) {
    message += `\nActive task: #${workflow.activeTaskId}`;
  } else if (state?.task) {
    message += "\nTask: no task was created for this state";
  } else {
    message += "\nTask: none configured for this state";
  }
  if (workflow.waitingMonitor) return message;

  if (unavailable.length > 0) {
    const details = unavailable.map((item) => `${item.outcome} — target state "${item.targetState}" exhausted its ${item.maxAttempts} attempt limit`);
    message += `\nUnavailable outcome${unavailable.length === 1 ? "" : "s"}: ${details.join("; ")}.`;
  }
  if (state?.terminal) return `${message}\nTerminal: ${state.terminal}`;
  if (outcomeEntries.length === 0) return `${message}\nNeeds attention: this state has no declared outcomes, so it cannot advance.`;
  if (outcomes.length === 0) {
    return `${message}\nBlocked: all declared outcomes are unavailable. Pause this workflow with LoopDelete action="pause", or abandon it with LoopDelete.`;
  }

  return `${message}\nChoose outcome: ${outcomes.join(", ")}\nNext: WorkflowTransition({ id: "${entry.id}", outcome: "${outcomes[0]}", evidence: "..." })`;
}

export function registerWorkflowTools(options: WorkflowToolsOptions): void {
  const {
    pi,
    getStore,
    getTriggerSystem,
    updateWidget,
    onDynamicLoopActivated,
    isTaskSystemReady,
    createWorkflowTask,
    completeWorkflowTask,
    closeWorkflowTask,
  } = options;

  pi.registerTool({
    name: "WorkflowCreate",
    label: "WorkflowCreate",
    renderCall: renderToolCall("Workflow", (args) => `create · ${String(toolArg(args, "goal") ?? "workflow").slice(0, 56)}`),
    renderResult: renderToolResult,
    description: "Create a task-driven workflow for named phases and outcomes. Use task: {subject, description} for state work. A state can use a cron loop policy (`schedule`, `maxFires`, `startImmediately`); only the active state's policy runs.",
    promptGuidelines: [
      "Use WorkflowCreate for named phase/outcome flows, not flat backlogs.",
      "Give nonterminal states concise prompts and explicit outcomes.",
      "WorkflowTransition settles linked state tasks; never terminally TaskUpdate them.",
      "A state loop repeats while that state remains active; only WorkflowTransition unlocks the next state's task and cadence.",
      "Model rework as outcome cycles bounded by maxAttempts; re-entry increments attempts.",
      "On each wake call WorkflowTransition once with id, outcome, evidence, and active-task claimId.",
    ],
    parameters: Type.Object({
      goal: Type.String({ description: "Overall workflow goal" }),
      definition: Type.String({ description: "Workflow JSON: version, initialState, and named states" }),
      maxFires: Type.Optional(Type.Integer({ description: "Maximum workflow wakes before automatic expiry (default: 30)", default: 30, minimum: 1 })),
    }),
    async execute(_toolCallId, params) {
      const parsed = parseWorkflowDefinition(params.definition);
      if (!parsed.definition) {
        const message = formatWorkflowDefinitionError(parsed.error);
        return textResult(message, {
          kind: "workflow",
          action: "create",
          tone: "error",
          summary: "Workflow definition rejected",
          expanded: [parsed.error ?? "unknown validation error", "Expand the tool result for a valid definition skeleton."],
        });
      }

      const initialState = parsed.definition.states[parsed.definition.initialState];
      if (initialState?.task && !isTaskSystemReady()) {
        const message = "Task system is still initializing; retry WorkflowCreate after task-provider detection settles.";
        return textResult(message, {
          kind: "workflow", action: "create", tone: "error", summary: "Workflow creation deferred", expanded: [message],
        });
      }

      let entry = getStore().create({ type: "dynamic" }, params.goal, {
        recurring: true,
        maxFires: params.maxFires ?? workflowDefaultMaxFires(parsed.definition),
        dynamic: { goal: params.goal, state: parsed.definition.initialState, iteration: 0 },
        workflow: parsed.definition,
      });
      const requiresInitialTask = Boolean(entry.workflow && initialState?.task && !initialState.terminal);
      const createdTaskId = requiresInitialTask ? await createWorkflowTask?.(entry) : undefined;
      let taskId: string | undefined;
      if (requiresInitialTask && !createdTaskId) {
        getStore().delete(entry.id);
        const message = `Workflow #${entry.id} was not created because its initial task could not be created. Retry after the task provider is available.`;
        updateWidget();
        return textResult(message, {
          kind: "workflow", action: "create", tone: "error", summary: `Workflow #${entry.id} task creation failed`, expanded: [message],
        });
      }
      if (createdTaskId && entry.workflow) {
        const bound = getStore().setWorkflowActiveTask(entry.id, createdTaskId, {
          currentState: entry.workflow.currentState,
          transitionSeq: entry.workflow.transitionSeq,
          activeTaskId: entry.workflow.activeTaskId,
        });
        if (bound) {
          entry = bound;
          taskId = createdTaskId;
        } else {
          const closed = await closeWorkflowTask?.(createdTaskId);
          getStore().delete(entry.id);
          const message = `Workflow #${entry.id} changed while initial task #${createdTaskId} was created; task cleanup ${closed ? "succeeded" : "failed"}.`;
          updateWidget();
          return textResult(message, {
            kind: "workflow", action: "create", tone: "error", summary: `Workflow #${entry.id} task binding rejected`, expanded: [message],
          });
        }
      }
      getTriggerSystem().add(entry);
      updateWidget();
      if (!entry.workflow || !getActiveWorkflowStateLoop(entry.workflow) || stateLoopStartsImmediately(entry)) {
        onDynamicLoopActivated?.(entry);
      }
      return textResult(
        `${formatWorkflowSummary(entry, `Workflow #${entry.id} created — ${entry.status}`)}\nWake: ${
          entry.workflow && getActiveWorkflowStateLoop(entry.workflow)
            ? stateLoopStartsImmediately(entry) ? "initial state wake queued now; subsequent wakes follow the state cadence." : "scheduled from the active state cadence."
            : "the state instruction will be delivered when the agent becomes idle."
        }`,
        {
          kind: "workflow",
          action: "create",
          tone: "success",
          summary: `Workflow #${entry.id} active · ${parsed.definition.initialState}${taskId ? ` · task #${taskId}` : ""}`,
          expanded: [
            `Goal: ${entry.prompt}`,
            `State: ${parsed.definition.initialState}`,
            `Outcome: ${Object.keys(parsed.definition.states[parsed.definition.initialState]?.on ?? {}).join(", ") || "none"}`,
            entry.workflow && getActiveWorkflowStateLoop(entry.workflow)
              ? `Cadence: ${getActiveWorkflowStateLoop(entry.workflow)?.schedule}`
              : "Wake: delivered when the agent becomes idle",
          ],
        },
      );
    },
  });

  pi.registerTool({
    name: "WorkflowTransition",
    label: "WorkflowTransition",
    renderCall: renderToolCall("Workflow", (args) => `transition · #${String(toolArg(args, "id") ?? "?")} → ${String(toolArg(args, "outcome") ?? "?")}`),
    renderResult: renderToolResult,
    description: "Advance one declared outcome and settle its linked task using the returned claimId; activeTaskId is invalid.",
    promptGuidelines: [
      "WorkflowTransition uses `id`, not `loopId`, and accepts outcome, evidence, and claimId—not activeTaskId.",
      "Use an exact outcome; inspect LoopList for state and attempt count.",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "Workflow loop ID" }),
      outcome: Type.String({ description: "Declared outcome for the current workflow state" }),
      evidence: Type.Optional(Type.String({ description: "Concise evidence supporting this transition" })),
      claimId: Type.Optional(Type.String({ description: "Claim token for the current state's active task" })),
    }),
    async execute(_toolCallId, params) {
      const store = getStore();
      const transitionInput = { outcome: params.outcome, evidence: params.evidence };
      const currentEntry = store.get(params.id);
      const sourceTaskId = currentEntry?.workflow?.activeTaskId;
      let destinationTaskId: string | undefined;
      if (currentEntry?.workflow) {
        const preview = transitionWorkflowRun(currentEntry.workflow, transitionInput, Date.now());
        if (!preview.applied) {
          const error = preview.error ?? "unknown transition error";
          return textResult(
            `Workflow #${params.id} did not transition\nReason: ${error}\n${formatWorkflowSummary(currentEntry, `Workflow #${params.id} remains — ${currentEntry.status}`, preview.failure)}`,
            { kind: "workflow", action: "transition", tone: "error", summary: `Workflow #${params.id} remains in ${currentEntry.workflow.currentState}`, expanded: [error] },
          );
        }
        const destinationState = preview.run.definition.states[preview.run.currentState];
        if (destinationState?.task && !destinationState.terminal) {
          destinationTaskId = await createWorkflowTask?.({ ...currentEntry, workflow: preview.run });
          if (!destinationTaskId) {
            const message = `Workflow #${params.id} did not transition because its destination task could not be created. Retry after the task provider is available.`;
            return textResult(message, {
              kind: "workflow", action: "transition", tone: "error", summary: `Workflow #${params.id} destination task creation failed`, expanded: [message],
            });
          }
        }
      }
      const sourceTaskClosed = sourceTaskId ? await completeWorkflowTask?.(sourceTaskId, params.claimId) : undefined;
      if (sourceTaskId && !sourceTaskClosed) {
        if (destinationTaskId) await closeWorkflowTask?.(destinationTaskId);
        const message = `Source task #${sourceTaskId} could not be completed; reclaim it and pass claimId before retrying the workflow transition.`;
        return textResult(message, {
          kind: "workflow", action: "transition", tone: "error", summary: `Workflow #${params.id} transition blocked by task #${sourceTaskId}`, expanded: [message],
        });
      }
      const expected = currentEntry?.workflow
        ? {
            currentState: currentEntry.workflow.currentState,
            transitionSeq: currentEntry.workflow.transitionSeq,
            activeTaskId: currentEntry.workflow.activeTaskId,
          }
        : undefined;
      const result = store.transitionWorkflow(params.id, transitionInput, expected);
      if (!result.applied || !result.entry) {
        if (destinationTaskId) await closeWorkflowTask?.(destinationTaskId);
        const current = store.get(params.id);
        if (current?.workflow) {
          const error = result.error ?? "unknown transition error";
          return textResult(
            `Workflow #${params.id} did not transition\nReason: ${error}\n${formatWorkflowSummary(current, `Workflow #${params.id} remains — ${current.status}`, result.failure)}`,
            { kind: "workflow", action: "transition", tone: "error", summary: `Workflow #${params.id} remains in ${current.workflow.currentState}`, expanded: [error] },
          );
        }
        return textResult(result.error ?? `Workflow loop #${params.id} did not transition`);
      }

      const entry = result.entry;
      getTriggerSystem().remove(entry.id);
      if (result.terminal === "completed") {
        updateWidget();
        return textResult(
          `Workflow #${entry.id} completed and deleted\nFinal transition: ${entry.workflow?.lastTransition?.from ?? "?"} → ${entry.workflow?.currentState ?? "?"}\nNext: no further workflow transition is needed.`,
          {
            kind: "workflow", action: "transition", tone: "success",
            summary: `Workflow #${entry.id} completed${sourceTaskClosed ? ` · task #${sourceTaskId} closed` : ""}`,
            expanded: [
              `Final transition: ${entry.workflow?.lastTransition?.from ?? "?"} → ${entry.workflow?.currentState ?? "?"}`,
              sourceTaskId ? `Source task #${sourceTaskId}: ${sourceTaskClosed ? "completed" : "not completed"}` : "Source task: none",
            ],
          },
        );
      }
      if (result.terminal === "paused") {
        updateWidget();
        return textResult(
          `Workflow #${entry.id} paused\nFinal state: ${entry.workflow?.currentState ?? "?"}\nNext: inspect it with LoopList. Terminal workflow states cannot be resumed; delete the loop when it is no longer needed.`,
          {
            kind: "workflow", action: "transition", tone: "warning",
            summary: `Workflow #${entry.id} paused · ${entry.workflow?.currentState ?? "?"}`,
            expanded: [
              sourceTaskId ? `Source task #${sourceTaskId}: ${sourceTaskClosed ? "completed" : "not completed"}` : "Source task: none",
              "Inspect LoopList before deleting this terminal workflow.",
            ],
          },
        );
      }

      const resumedEntry = entry.status === "paused" ? store.resume(entry.id) ?? entry : entry;
      let updatedEntry = resumedEntry;
      if (destinationTaskId && resumedEntry.workflow) {
        const bound = store.setWorkflowActiveTask(resumedEntry.id, destinationTaskId, {
          currentState: resumedEntry.workflow.currentState,
          transitionSeq: resumedEntry.workflow.transitionSeq,
          activeTaskId: resumedEntry.workflow.activeTaskId,
        });
        if (!bound) {
          await closeWorkflowTask?.(destinationTaskId);
          const message = `Workflow #${resumedEntry.id} changed while destination task #${destinationTaskId} was created; the task was closed. Inspect LoopList before retrying.`;
          return textResult(message, {
            kind: "workflow", action: "transition", tone: "error", summary: `Workflow #${resumedEntry.id} task binding rejected`, expanded: [message],
          });
        }
        updatedEntry = bound;
      }
      const taskId = destinationTaskId;
      getTriggerSystem().add(updatedEntry);
      updateWidget();
      if (stateLoopStartsImmediately(updatedEntry)) onDynamicLoopActivated?.(updatedEntry);
      const from = updatedEntry.workflow?.lastTransition?.from ?? "?";
      const to = updatedEntry.workflow?.currentState ?? "?";
      return textResult(
        `Workflow #${updatedEntry.id} advanced: ${from} → ${to}\n${formatWorkflowSummary(updatedEntry, `Workflow #${updatedEntry.id} — ${updatedEntry.status}`)}`,
        {
          kind: "workflow", action: "transition", tone: "success",
          summary: `Workflow #${updatedEntry.id} · ${from} → ${to}${taskId ? ` · task #${taskId}` : ""}`,
          expanded: [
            `Instruction: ${updatedEntry.workflow?.definition.states[to]?.prompt ?? ""}`,
            `Outcome: ${Object.keys(updatedEntry.workflow?.definition.states[to]?.on ?? {}).join(", ") || "none"}`,
            sourceTaskId ? `Source task #${sourceTaskId}: ${sourceTaskClosed ? "completed" : "not completed"}` : "Source task: none",
          ],
        },
      );
    },
  });
}
