import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatTrigger } from "../loop-format.js";
import { parseInterval } from "../loop-parse.js";
import { getOrchestrationCounts } from "../orchestration-reducer.js";
import type { LoopEntry, Trigger } from "../types.js";
import { renderToolCall, renderToolResult, toolArg } from "../ui/tool-renderer.js";
import { deriveWorkflowActivity, formatCompactWorkflowDuration } from "../ui/workflow-presentation.js";
import { getActiveWorkflowStateLoop } from "../workflow-reducer.js";
import { displayRows, textResult } from "./tool-result.js";
import { formatWorkflowSummary } from "./workflow-tools.js";

interface LoopStoreLike {
  list(): LoopEntry[];
  get(id: string): LoopEntry | undefined;
  create(trigger: Trigger, prompt: string, opts: {
    recurring: boolean;
    autoTask?: boolean;
    taskBacklog?: boolean;
    readOnly?: boolean;
    maxFires?: number;
    dynamic?: Partial<NonNullable<LoopEntry["dynamic"]>>;
  }): LoopEntry;
  pause(id: string): LoopEntry | undefined;
  continueDynamic(
    id: string,
    fields: { prompt?: string; dynamic: Partial<NonNullable<LoopEntry["dynamic"]>> },
    expected?: { status: LoopEntry["status"]; iteration: number; updatedAt: number },
  ): LoopEntry | undefined;
  stopDynamic(
    id: string,
    status: "completed" | "paused",
    expected: { status: LoopEntry["status"]; iteration: number; updatedAt: number },
  ): boolean;
  getDeletionTombstone(id: string): { reason: string; pendingCount?: number } | undefined;
  delete(id: string): boolean;
}

interface TriggerSystemLike {
  add(entry: LoopEntry): void;
  remove(id: string): void;
}

interface SchedulerLike {
  nextFire(id: string): number | undefined;
}

interface MonitorLike {
  id: string;
  status: string;
}

interface MonitorManagerLike {
  get(id: string): MonitorLike | undefined;
}

export interface LoopToolsOptions {
  pi: ExtensionAPI;
  getStore: () => LoopStoreLike;
  getTriggerSystem: () => TriggerSystemLike;
  getScheduler: () => SchedulerLike;
  getMonitorManager: () => MonitorManagerLike;
  updateWidget: () => void;
  maybeBootstrapTaskLoop: (entry: LoopEntry) => Promise<boolean>;
  isTaskSystemReady: () => boolean;
  onDynamicLoopActivated?: (entry: LoopEntry) => void;
  cancelOrchestration?: (id: string, action: "pause" | "delete") => Promise<boolean>;
}

function validateTrigger(trigger: Trigger): string | null {
  if (trigger.type === "cron") {
    const parts = trigger.schedule.trim().split(/\s+/);
    if (parts.length !== 5) {
      return `Invalid cron trigger. Expected 5 fields, got ${parts.length}: "${trigger.schedule}". Use formats like "5m", "1h", "0 9 * * 1-5", or set triggerType to "event" for event sources.`;
    }
  } else if (trigger.type === "event") {
    if (!trigger.source || trigger.source.trim().length === 0) {
      return "Invalid event trigger. Event source must be non-empty (e.g., \"tool_execution_start\").";
    }
  } else if (trigger.type === "hybrid") {
    const cronParts = trigger.cron.trim().split(/\s+/);
    if (cronParts.length !== 5) {
      return `Invalid hybrid trigger. Cron part must have 5 fields, got ${cronParts.length}: "${trigger.cron}".`;
    }
    if (!trigger.event.source || trigger.event.source.trim().length === 0) {
      return "Invalid hybrid trigger. Event source must be non-empty (e.g., \"tool_execution_start\").";
    }
  }
  return null;
}

function inferTriggerType(input: string): "cron" | "event" | "hybrid" {
  if (input.includes("hybrid") || (input.includes("cron") && input.includes("event"))) return "hybrid";
  if (/^\d+\s*[smhd]$/i.test(input.trim())) return "cron";
  if (/^(\*|\d+)/.test(input.trim()) && input.trim().split(/\s+/).length === 5) return "cron";
  return "event";
}

function formatRemaining(ms: number): string {
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
  return `${Math.round(ms / 3600000)}h`;
}

function parseDelayMs(input: string): number | undefined {
  const match = input.trim().match(/^(\d+)\s*(s|m|h|d)$/i);
  if (!match) return undefined;
  const value = Number.parseInt(match[1] ?? "", 10);
  const unit = (match[2] ?? "").toLowerCase();
  const multiplier = unit === "s" ? 1000 : unit === "m" ? 60000 : unit === "h" ? 3600000 : 86400000;
  const delayMs = value * multiplier;
  if (!Number.isSafeInteger(delayMs) || delayMs <= 0 || delayMs > 7 * 24 * 60 * 60 * 1000) return undefined;
  return delayMs;
}

interface LoopUpdateParams {
  id: string;
  status: "continue" | "completed" | "paused";
  state?: string;
  metrics?: string;
  doneCriteria?: string;
  nextInterval?: string;
  prompt?: string;
}

function resolveNextWakeAt(nextInterval?: string): { nextWakeAt?: number; error?: string } {
  if (!nextInterval) return { nextWakeAt: undefined };
  const parsedDelayMs = parseDelayMs(nextInterval);
  if (!parsedDelayMs) return { error: `Invalid nextInterval "${nextInterval}". Use formats like 3m, 30s, or 1h.` };
  return { nextWakeAt: Date.now() + parsedDelayMs };
}


function formatDynamicUpdateResult(id: string, iteration: number | undefined, nextWakeAt: number | undefined, resumed: boolean): string {
  const mode = nextWakeAt === undefined
    ? "Next wake: when idle"
    : `Next wake: ${formatRemaining(Math.max(0, nextWakeAt - Date.now()))}`;
  return `Dynamic loop #${id} ${resumed ? "resumed and updated" : "updated"}\n` +
    `Iteration: ${iteration ?? "?"}` +
    `\n${mode}`;
}

function formatDeletionTombstone(id: string, tombstone: { reason: string; pendingCount?: number }): string {
  const detail = tombstone.pendingCount === undefined ? "" : ` (pending: ${tombstone.pendingCount})`;
  return `Loop #${id} already auto-deleted: ${tombstone.reason}${detail}`;
}

function continueDynamicLoop(
  params: LoopUpdateParams,
  entry: LoopEntry & { dynamic: NonNullable<LoopEntry["dynamic"]> },
  store: LoopStoreLike,
  triggerSystem: TriggerSystemLike,
): { applied: boolean; message: string } {
  if (Date.now() >= entry.expiresAt) {
    return { applied: false, message: `Loop #${params.id} has expired; recreate it explicitly if work remains.` };
  }
  const { nextWakeAt, error } = resolveNextWakeAt(params.nextInterval);
  if (error) return { applied: false, message: error };
  if (nextWakeAt !== undefined && nextWakeAt >= entry.expiresAt) {
    return { applied: false, message: `nextInterval exceeds loop #${params.id}'s remaining lifetime.` };
  }

  const resumed = entry.status === "paused";
  const updated = store.continueDynamic(params.id, {
    prompt: params.prompt,
    dynamic: {
      goal: params.prompt ?? entry.dynamic.goal,
      state: params.state,
      metrics: params.metrics,
      doneCriteria: params.doneCriteria,
      iteration: (entry.dynamic.iteration ?? 0) + 1,
      nextWakeAt,
      awaitingUpdate: false,
      lastUpdatedAt: Date.now(),
    },
  }, {
    status: entry.status,
    iteration: entry.dynamic.iteration ?? 0,
    updatedAt: entry.updatedAt,
  });
  if (!updated) {
    return { applied: false, message: `Loop #${params.id} changed while the update was applied; inspect LoopList and retry.` };
  }
  triggerSystem.remove(params.id);
  triggerSystem.add(updated);
  return { applied: true, message: formatDynamicUpdateResult(params.id, updated.dynamic?.iteration, nextWakeAt, resumed) };
}

function stopDynamicLoop(
  params: LoopUpdateParams,
  entry: LoopEntry & { dynamic: NonNullable<LoopEntry["dynamic"]> },
  store: LoopStoreLike,
  triggerSystem: TriggerSystemLike,
): { applied: boolean; message: string } {
  const status = params.status === "completed" ? "completed" : "paused";
  const applied = store.stopDynamic(params.id, status, {
    status: entry.status,
    iteration: entry.dynamic.iteration ?? 0,
    updatedAt: entry.updatedAt,
  });
  if (!applied) {
    return { applied: false, message: `Loop #${params.id} changed while the update was applied; inspect LoopList and retry.` };
  }
  triggerSystem.remove(params.id);
  return {
    applied: true,
    message: status === "completed" ? `Dynamic loop #${params.id} completed and deleted` : `Dynamic loop #${params.id} paused`,
  };
}

export function registerLoopTools(options: LoopToolsOptions): void {
  const {
    pi,
    getStore,
    getTriggerSystem,
    getScheduler,
    getMonitorManager,
    updateWidget,
    maybeBootstrapTaskLoop,
    isTaskSystemReady,
    onDynamicLoopActivated,
    cancelOrchestration,
  } = options;

  pi.registerTool({
    name: "LoopCreate",
    label: "LoopCreate",
    renderCall: renderToolCall("Loop", (args) => `create · ${String(toolArg(args, "prompt") ?? "scheduled work").slice(0, 56)}`),
    renderResult: renderToolResult,
    description: `Create a persistent cron, event, hybrid, or idle loop for recurring checks, event reactions, or autonomous backlog processing; never use shell sleep loops. Polling needs maxFires; observation-only loops should be readOnly. A completed iteration, unchanged result, or temporarily empty check is not a reason to delete the loop.`,
    promptGuidelines: [
      "Prefer event triggers; use triggerType `idle` with trigger `idle` for agent-paced continuation of one evolving goal that does not need WorkflowCreate phases/outcomes.",
      "For autonomous backlogs use event `tasks:created`, recurring true, taskBacklog true, and bounded maxFires; never combine taskBacklog with autoTask or manually delete its loop.",
      "Use LoopDelete only for explicit cancellation or a satisfied stop condition—not after a normal, empty, or unchanged iteration. Report the created loop ID.",
    ],
    parameters: Type.Object({
      trigger: Type.String({ description: "Cron expression (e.g., '5m', '1h', '0 9 * * 1-5'), event source (e.g., 'tool_execution_start'), hybrid spec, or literal 'idle' with triggerType='idle'" }),
      prompt: Type.String({ description: "Prompt to run when the loop fires" }),
      recurring: Type.Optional(Type.Boolean({ description: "Whether loop repeats (default: true)", default: true })),
      autoTask: Type.Optional(Type.Boolean({ description: "Auto-create pi-tasks task on fire", default: false })),
      taskBacklog: Type.Optional(Type.Boolean({ description: "Native task queue worker only: requires recurring event trigger 'tasks:created' and auto-deletes when pending tasks reach zero", default: false })),
      triggerType: Type.Optional(Type.String({ description: "cron, event, hybrid, or idle (cron/event inferred from trigger string if omitted)", enum: ["cron", "event", "hybrid", "idle"] })),
      debounceMs: Type.Optional(Type.Number({ description: "Debounce for hybrid triggers (default: 30000)", default: 30000 })),
      readOnly: Type.Optional(Type.Boolean({ description: "Restrict the agent to read-only tools when this loop fires (default: false)", default: false })),
      maxFires: Type.Optional(Type.Integer({ description: "Auto-stop after N fires. Prevents infinite token burn on polling loops.", minimum: 1 })),
    }),
    async execute(_toolCallId, params) {
      const { trigger: triggerInput, prompt, recurring, autoTask, taskBacklog, triggerType, debounceMs, readOnly, maxFires } = params;

      let trigger: Trigger;
      const inferred = triggerType ?? inferTriggerType(triggerInput);

      if (inferred === "idle") {
        if (triggerInput.trim().toLowerCase() !== "idle") {
          const message = 'Idle loops require trigger "idle" with triggerType "idle".';
          return Promise.resolve(textResult(message, {
            kind: "loop",
            action: "create",
            tone: "error",
            summary: "Idle loop was not created",
            expanded: [message],
          }));
        }
        trigger = { type: "dynamic" };
      } else if (inferred === "cron") {
        const parsed = parseInterval(triggerInput);
        trigger = { type: "cron", schedule: parsed.cron };
      } else if (inferred === "event") {
        trigger = { type: "event", source: triggerInput };
      } else {
        const cronPart = triggerInput.match(/cron:?\s*(\S+)/)?.[1] || triggerInput;
        const eventPart = triggerInput.match(/event:?\s*(\S+)/)?.[1];
        const parsed = parseInterval(cronPart);
        trigger = {
          type: "hybrid",
          cron: parsed.cron,
          event: { source: eventPart || "tool_execution_start" },
          debounceMs: debounceMs ?? 30000,
        };
      }

      const validationError = validateTrigger(trigger);
      if (validationError) {
        return Promise.resolve(textResult(validationError, {
          kind: "loop",
          action: "create",
          tone: "error",
          summary: "Loop was not created",
          expanded: [validationError],
        }));
      }
      let backlogEventSource: string | undefined;
      if (trigger.type === "event") backlogEventSource = trigger.source;
      else if (trigger.type === "hybrid") backlogEventSource = trigger.event.source;
      let backlogError: string | undefined;
      if (taskBacklog && autoTask) backlogError = "taskBacklog loops cannot enable autoTask; backlog workers adopt existing tasks instead of creating more.";
      else if (taskBacklog && recurring === false) backlogError = "taskBacklog loops must be recurring.";
      else if (taskBacklog && backlogEventSource !== "tasks:created") {
        backlogError = 'taskBacklog loops require a "tasks:created" event trigger. For a broad goal, use trigger "idle" with triggerType "idle" and omit taskBacklog.';
      }
      if (backlogError) {
        return Promise.resolve(textResult(backlogError, {
          kind: "loop",
          action: "create",
          tone: "error",
          summary: "Backlog loop was not created",
          expanded: [backlogError],
        }));
      }

      const entry = getStore().create(trigger, prompt, {
        recurring: taskBacklog ? true : recurring ?? (inferred !== "event"),
        autoTask,
        taskBacklog,
        readOnly,
        maxFires: maxFires ?? (taskBacklog ? 25 : undefined),
        dynamic: trigger.type === "dynamic"
          ? { goal: prompt, iteration: 0 }
          : undefined,
      });

      getTriggerSystem().add(entry);
      if (trigger.type === "dynamic") onDynamicLoopActivated?.(entry);

      if (trigger.type === "event" && trigger.source === "monitor:done" && trigger.filter) {
        try {
          const filterObj = JSON.parse(trigger.filter);
          const monitorId = filterObj.monitorId as string | undefined;
          if (monitorId) {
            const monitor = getMonitorManager().get(monitorId);
            if (monitor && monitor.status !== "running") {
              getTriggerSystem().remove(entry.id);
              getStore().delete(entry.id);
            }
          }
        } catch {
          // ignore malformed monitor filter; loop remains registered
        }
      }

      const bootstrapped = await maybeBootstrapTaskLoop(entry);
      updateWidget();

      const triggerDesc = trigger.type === "dynamic" ? "idle-driven" : formatTrigger(trigger, "create");

      return Promise.resolve(textResult(
        `Loop #${entry.id} created: ${entry.prompt.slice(0, 60)}\n` +
        `Trigger: ${triggerDesc}\n` +
        `Recurring: ${entry.recurring}\n` +
        (trigger.type === "dynamic" ? "Wake: when idle (first wake queued now)\n" : "") +
        (entry.autoTask ? "Auto-create task: enabled\n" : "") +
        (entry.taskBacklog ? "Backlog worker: enabled\n" : "") +
        (bootstrapped ? "Backlog: initial wake queued for existing pending tasks\n" : "") +
        (isTaskSystemReady() ? "" : "Task system: not ready yet — autoTask may not fire until native fallback or pi-tasks becomes available\n") +
        `ID: ${entry.id} (persists until explicitly canceled or a configured stop condition is met)`,
        {
          kind: "loop",
          action: "create",
          tone: "success",
          summary: `Loop #${entry.id} active · ${triggerDesc}`,
          expanded: [
            `Goal: ${entry.prompt}`,
            `Trigger: ${triggerDesc}`,
            entry.autoTask ? "Auto-task: enabled" : "Auto-task: off",
          ],
        },
      ));
    },
  });

  pi.registerTool({
    name: "LoopList",
    label: "LoopList",
    renderCall: renderToolCall("Loop", () => "status"),
    renderResult: renderToolResult,
    description: "List controllers, IDs, triggers, and next-fire times; use before create/delete.",
    parameters: Type.Object({}),
    execute() {
      const loops = getStore().list();
      if (loops.length === 0) {
        return Promise.resolve(textResult("No loops configured. Use LoopCreate to set up a schedule.", {
          kind: "loop", action: "list", tone: "info", summary: "No loops", expanded: ["Use LoopCreate to set up a schedule."],
        }));
      }

      const lines: string[] = [];
      const now = Date.now();
      for (const entry of loops) {
        const workflowSchedule = entry.workflow && getActiveWorkflowStateLoop(entry.workflow)?.schedule;
        const triggerDesc = workflowSchedule ? `workflow cron: ${workflowSchedule}` : formatTrigger(entry.trigger, "list");

        const nextFire = workflowSchedule || entry.trigger.type === "cron" || entry.trigger.type === "hybrid" || entry.dynamic?.nextWakeAt !== undefined
          ? getScheduler().nextFire(entry.id)
          : undefined;
        const activity = entry.workflow ? deriveWorkflowActivity(entry, now) : undefined;
        const statusIcon = entry.status === "active" ? "*" : entry.status === "paused" ? "-" : "x";
        let line = `${statusIcon} #${entry.id} [${entry.status}] ${entry.prompt.slice(0, 60)}`;
        line += ` (${triggerDesc})`;
        if (activity) line += ` [activity:${activity.status} ${formatCompactWorkflowDuration(activity.activityMs)}]`;
        line += ` expiresAt: ${new Date(entry.expiresAt).toISOString()}`;
        if (nextFire) {
          const remaining = Math.max(0, nextFire - now);
          line += ` next: ${formatRemaining(remaining)}`;
        }
        if (activity) {
          line += ` age: ${formatCompactWorkflowDuration(activity.workflowAgeMs)}`;
        } else if (entry.status === "active") {
          line += ` age: ${formatRemaining(Math.max(0, now - entry.createdAt))}`;
        }
        if (entry.pause) line += ` [pause:${entry.pause.kind}]`;
        if (entry.autoTask) line += " [auto-task]";
        if (entry.taskBacklog) line += " [backlog-worker]";
        if (entry.orchestration) {
          const counts = getOrchestrationCounts(entry.orchestration);
          line += ` [orchestration:${entry.orchestration.status}]`;
          line += ` pending=${counts.pending} active=${counts.active} completed=${counts.completed} failed=${counts.failed} uncertain=${counts.uncertain}`;
          lines.push(line);
        } else if (entry.workflow && activity) {
          line += ` [workflow:${entry.workflow.currentState} ${formatCompactWorkflowDuration(activity.stateAgeMs)}]`;
          lines.push(formatWorkflowSummary(entry, line, undefined, now));
        } else {
          lines.push(line);
        }
      }

      const workflowCount = loops.filter((entry) => entry.workflow !== undefined).length;
      const orchestrationCount = loops.filter((entry) => entry.orchestration !== undefined).length;
      const ordinaryCount = loops.length - workflowCount - orchestrationCount;
      const kinds = [
        ordinaryCount > 0 ? `${ordinaryCount} loop${ordinaryCount === 1 ? "" : "s"}` : undefined,
        workflowCount > 0 ? `${workflowCount} workflow${workflowCount === 1 ? "" : "s"}` : undefined,
        orchestrationCount > 0 ? `${orchestrationCount} orchestration${orchestrationCount === 1 ? "" : "s"}` : undefined,
      ].filter((label): label is string => label !== undefined);
      return Promise.resolve(textResult(lines.join("\n"), {
        kind: "loop",
        action: "list",
        tone: "info",
        summary: `${kinds.join(" · ")} · ${loops.filter((entry) => entry.status === "active").length} active`,
        expanded: displayRows(lines, workflowCount > 0 ? 16 : 8),
      }));
    },
  });

  pi.registerTool({
    name: "LoopUpdate",
    label: "LoopUpdate",
    renderCall: renderToolCall("Loop", (args) => `update · #${String(toolArg(args, "id") ?? "?")} · ${String(toolArg(args, "status") ?? "continue")}`),
    renderResult: renderToolResult,
    description: `Update a dynamic loop exactly once after each wake. Use "continue" with state/metrics and optional nextInterval whenever work remains, including empty or unchanged iterations; "completed" only when done; "paused" only for a genuine blocker or required user authority. Persist before notifying the user; never use LoopDelete to finish an iteration.`,
    parameters: Type.Object({
      id: Type.String({ description: "Dynamic loop ID to update" }),
      status: Type.String({ description: "continue, completed, or paused", enum: ["continue", "completed", "paused"] }),
      state: Type.Optional(Type.String({ description: "Current progress/state summary" })),
      metrics: Type.Optional(Type.String({ description: "Current metrics/check results" })),
      doneCriteria: Type.Optional(Type.String({ description: "Definition of done for the dynamic loop" })),
      nextInterval: Type.Optional(Type.String({ description: "When to wake next, e.g. 3m, 30s, 1h" })),
      prompt: Type.Optional(Type.String({ description: "Optional updated goal/prompt text" })),
    }),
    execute(_toolCallId, params: LoopUpdateParams) {
      const store = getStore();
      const triggerSystem = getTriggerSystem();
      const entry = store.get(params.id);
      if (!entry) {
        return Promise.resolve(textResult(`Loop #${params.id} not found`, {
          kind: "loop", action: "update", tone: "error", summary: `Loop #${params.id} not found`, expanded: ["Use LoopList to find valid loop IDs."],
        }));
      }
      if (entry.orchestration) {
        const message = `Loop #${params.id} is orchestration-owned. Use OrchestrationGet to inspect it or LoopDelete to cancel it.`;
        return Promise.resolve(textResult(message, {
          kind: "loop", action: "update", tone: "error", summary: `Loop #${params.id} update rejected`, expanded: [message],
        }));
      }
      if (entry.workflow) {
        const message = `Loop #${params.id} is workflow-owned. Use WorkflowTransition for state changes or LoopDelete to cancel it.`;
        return Promise.resolve(textResult(message, {
          kind: "loop", action: "update", tone: "error", summary: `Loop #${params.id} update rejected`, expanded: [message],
        }));
      }
      if (entry.trigger.type !== "dynamic" || !entry.dynamic) {
        return Promise.resolve(textResult(`Loop #${params.id} is not a dynamic loop`, {
          kind: "loop", action: "update", tone: "error", summary: `Loop #${params.id} is not dynamic`, expanded: ["Use LoopUpdate only for dynamic loops."],
        }));
      }

      const dynamicEntry = entry as LoopEntry & { dynamic: NonNullable<LoopEntry["dynamic"]> };
      const outcome = params.status === "continue"
        ? continueDynamicLoop(params, dynamicEntry, store, triggerSystem)
        : stopDynamicLoop(params, dynamicEntry, store, triggerSystem);
      if (!outcome.applied) {
        return Promise.resolve(textResult(outcome.message, {
          kind: "loop", action: "update", tone: "error", summary: `Loop #${params.id} update rejected`, expanded: [outcome.message],
        }));
      }
      const message = outcome.message;
      updateWidget();
      const tone = params.status === "paused" ? "warning" : "success";
      const summary = params.status === "completed"
        ? `Loop #${params.id} completed`
        : params.status === "paused"
          ? `Loop #${params.id} paused`
          : `Loop #${params.id} updated`;
      return Promise.resolve(textResult(message, {
        kind: "loop",
        action: "update",
        tone,
        summary,
        expanded: params.status === "continue"
          ? [`State: ${params.state ?? entry.dynamic.state ?? "unchanged"}`, `Next wake: ${params.nextInterval ?? "when idle"}`]
          : [],
      }));
    },
  });

  pi.registerTool({
    name: "LoopDelete",
    label: "LoopDelete",
    renderCall: renderToolCall("Loop", (args) => `${String(toolArg(args, "action") ?? "delete")} · #${String(toolArg(args, "id") ?? "?")}`),
    renderResult: renderToolResult,
    description: `Pause or delete a loop. Do neither after a normal, empty, or unchanged iteration: recurring loops persist and dynamic loops use LoopUpdate. Delete only for explicit cancellation or a satisfied stop condition; pause only for a genuine temporary blocker or required user authority.`,
    parameters: Type.Object({
      id: Type.String({ description: "Loop ID to delete or pause" }),
      action: Type.Optional(Type.String({ description: "delete or pause (default: delete)", enum: ["delete", "pause"], default: "delete" })),
    }),
    async execute(_toolCallId, params) {
      const { id, action } = params;
      const existing = getStore().get(id);
      if (existing?.orchestration) {
        const orchestrationAction: "pause" | "delete" = action === "pause" ? "pause" : "delete";
        const cancelled = await cancelOrchestration?.(id, orchestrationAction);
        if (!cancelled) {
          const message = `Orchestration #${id} cancellation failed`;
          return textResult(message, {
            kind: "loop", action: orchestrationAction, tone: "error", summary: message, expanded: ["Inspect OrchestrationGet and retry."],
          });
        }
        const message = orchestrationAction === "pause" ? `Orchestration #${id} cancelled and paused` : `Orchestration #${id} cancelled and deleted`;
        return textResult(message, {
          kind: "loop", action: orchestrationAction, tone: orchestrationAction === "pause" ? "warning" : "success", summary: message, expanded: [],
        });
      }

      if (action === "pause") {
        const entry = getStore().pause(id);
        if (!entry) {
          const tombstone = getStore().getDeletionTombstone(id);
          if (tombstone) {
            return Promise.resolve(textResult(formatDeletionTombstone(id, tombstone), {
              kind: "loop", action: "pause", tone: "warning", summary: `Loop #${id} was already removed`, expanded: [formatDeletionTombstone(id, tombstone)],
            }));
          }
          return Promise.resolve(textResult(`Loop #${id} not found`, {
            kind: "loop", action: "pause", tone: "error", summary: `Loop #${id} not found`, expanded: ["Use LoopList to find valid loop IDs."],
          }));
        }
        getTriggerSystem().remove(id);
        updateWidget();
        return Promise.resolve(textResult(`Loop #${id} paused`, {
          kind: "loop", action: "pause", tone: "warning", summary: `Loop #${id} paused`, expanded: ["Use LoopList to inspect paused loops."],
        }));
      }

      getTriggerSystem().remove(id);
      const deleted = getStore().delete(id);
      updateWidget();
      if (deleted) {
        return Promise.resolve(textResult(`Loop #${id} deleted`, {
          kind: "loop", action: "delete", tone: "success", summary: `Loop #${id} deleted`, expanded: [],
        }));
      }
      const tombstone = getStore().getDeletionTombstone(id);
      if (tombstone) {
        return Promise.resolve(textResult(formatDeletionTombstone(id, tombstone), {
          kind: "loop", action: "delete", tone: "warning", summary: `Loop #${id} was already removed`, expanded: [formatDeletionTombstone(id, tombstone)],
        }));
      }
      return Promise.resolve(textResult(`Loop #${id} not found`, {
        kind: "loop", action: "delete", tone: "error", summary: `Loop #${id} not found`, expanded: ["Use LoopList to find valid loop IDs."],
      }));
    },
  });
}
