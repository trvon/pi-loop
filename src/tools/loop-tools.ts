import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatTrigger } from "../loop-format.js";
import { parseInterval } from "../loop-parse.js";
import type { LoopEntry, Trigger } from "../types.js";
import { textResult } from "./tool-result.js";

interface LoopStoreLike {
  list(): LoopEntry[];
  get(id: string): LoopEntry | undefined;
  create(trigger: Trigger, prompt: string, opts: {
    recurring: boolean;
    autoTask?: boolean;
    taskBacklog?: boolean;
    readOnly?: boolean;
    maxFires?: number;
  }): LoopEntry;
  pause(id: string): LoopEntry | undefined;
  updateDynamic(id: string, fields: { prompt?: string; dynamic: Partial<NonNullable<LoopEntry["dynamic"]>> }): LoopEntry | undefined;
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
  return value * multiplier;
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

function formatDynamicUpdateResult(id: string, iteration: number | undefined, nextWakeAt: number | undefined): string {
  const mode = nextWakeAt === undefined
    ? "Next wake: when idle"
    : `Next wake: ${formatRemaining(Math.max(0, nextWakeAt - Date.now()))}`;
  return `Dynamic loop #${id} updated\n` +
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
): string {
  const { nextWakeAt, error } = resolveNextWakeAt(params.nextInterval);
  if (error) return error;

  const updated = store.updateDynamic(params.id, {
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
  });
  if (updated) {
    triggerSystem.remove(params.id);
    triggerSystem.add(updated);
  }
  return formatDynamicUpdateResult(params.id, updated?.dynamic?.iteration, nextWakeAt);
}

function stopDynamicLoop(
  params: LoopUpdateParams,
  store: LoopStoreLike,
  triggerSystem: TriggerSystemLike,
): string {
  triggerSystem.remove(params.id);
  if (params.status === "completed") {
    store.delete(params.id);
    return `Dynamic loop #${params.id} completed and deleted`;
  }
  store.pause(params.id);
  return `Dynamic loop #${params.id} paused`;
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
  } = options;

  pi.registerTool({
    name: "LoopCreate",
    label: "LoopCreate",
    description: `Create a scheduled repeating task (loop) that runs a prompt on a timer or when an event fires.

Use this tool whenever the user asks to:
- "create a loop" to check something periodically
- "run every X seconds/minutes/hours"
- "remind me to check..."
- "watch for..." or "when X happens, do Y"
- "schedule a recurring check"
- set up a periodic monitor or poller
- has a task list with open items — create a loop to work through tasks automatically

DO NOT use raw Bash loops (for/sleep/while). Use LoopCreate instead — it integrates with the session lifecycle, survives across turns, and the scheduler handles timing.

## When NOT to Use

Skip this tool when the task is a one-off check (just do it directly) or when the user wants a purely reactive hook.

## Trigger Types

- **cron**: time-based. "30s" (rounded to 1m), "5m", "2h", "1d", or full cron like "0 9 * * 1-5"
- **event**: fires on pi events like "tool_execution_start", "before_agent_start"
- **hybrid**: both cron + event with debounce

## Parameters

- **trigger**: interval like "30s", "5m", "2h", event source, or hybrid spec
- **prompt**: what to do when the loop fires (e.g., "check if the build passed")
- **recurring**: repeat or fire once (default: true)
- **autoTask**: when pi-tasks is loaded or native task fallback is active, auto-create a task on each fire
- **taskBacklog**: mark this as a task-backlog worker loop so it auto-deletes when pending tasks reach zero
- **readOnly**: restrict the agent to read-only tools when this loop fires (default: false)
- **maxFires**: auto-stop after N fires — prevents infinite token burn on polling loops

## Loop Lifecycle

Recurring loops persist across fires. A completed iteration, unchanged result, or temporarily empty check is not a reason to delete the loop. Delete only when the user explicitly cancels it or its stated stop condition is satisfied. Dynamic loops must be advanced with LoopUpdate, not LoopDelete.`,
    promptGuidelines: [
      "Use LoopCreate when the user asks for a repeating task, periodic check, scheduled reminder, or 'every X' — never use raw Bash for/sleep/while.",
      "## Choosing trigger type",
      "Prefer event triggers over cron when possible — they fire exactly when needed instead of polling.",
      "Use event triggers for: tool completion ('tool_execution_end'), task creation ('tasks:created'), monitor completion ('monitor:done').",
      "Use cron triggers only when: the user explicitly asks for a time interval, or there's no relevant pi event to subscribe to.",
      "Hybrid triggers (cron + event) give you both: event-driven responsiveness with a cron safety-net fallback.",
      "## Choosing an interval",
      "Default to 5m unless the user specifies differently. Use shorter intervals only when time-sensitive.",
      "## maxFires — prevent infinite token burn",
      "Always set maxFires on polling loops so they don't run forever. For task-continuation loops, use maxFires: 20-50.",
      "Recurring loops are persistent controllers. Do not call LoopDelete after a normal fire, an unchanged check, or one completed iteration; only delete when the user explicitly asks to cancel or the loop's stated stop condition is satisfied.",
      "## readOnly mode",
      "Set readOnly: true for loops that only observe and report (checks, status polls). This prevents unintended changes.",
      "## Task-driven workflows",
      "Do not rely on a past 'tasks:created' event to replay. If tasks already exist, bootstrap the first pass in the current turn or use a hybrid/event loop that can catch future task creation and a cron safety-net.",
      "Use autoTask only when you want the loop itself to create a task on each fire. For processing an existing task backlog, leave autoTask off and have the loop run TaskList to pick the next pending task.",
      "Set taskBacklog: true for backlog worker loops that process the existing pending queue. Backlog worker loops bootstrap against existing pending tasks and auto-delete when the queue reaches zero.",
      "For taskBacklog loops, do not instruct the agent to delete the loop; pi-loop auto-deletes it when the pending count reaches zero.",
      "After creating a loop, tell the user the loop ID so they can cancel it with LoopDelete.",
    ],
    parameters: Type.Object({
      trigger: Type.String({ description: "Cron expression (e.g., '5m', '1h', '0 9 * * 1-5'), event source (e.g., 'tool_execution_start'), or JSON hybrid spec" }),
      prompt: Type.String({ description: "Prompt to run when the loop fires" }),
      recurring: Type.Optional(Type.Boolean({ description: "Whether loop repeats (default: true)", default: true })),
      autoTask: Type.Optional(Type.Boolean({ description: "Auto-create pi-tasks task on fire", default: false })),
      taskBacklog: Type.Optional(Type.Boolean({ description: "Mark as a task-backlog worker loop that auto-deletes when pending tasks reach zero", default: false })),
      triggerType: Type.Optional(Type.String({ description: "cron, event, or hybrid (inferred from trigger string if omitted)", enum: ["cron", "event", "hybrid"] })),
      debounceMs: Type.Optional(Type.Number({ description: "Debounce for hybrid triggers (default: 30000)", default: 30000 })),
      readOnly: Type.Optional(Type.Boolean({ description: "Restrict the agent to read-only tools when this loop fires (default: false)", default: false })),
      maxFires: Type.Optional(Type.Number({ description: "Auto-stop after N fires. Prevents infinite token burn on polling loops." })),
    }),
    async execute(_toolCallId, params) {
      const { trigger: triggerInput, prompt, recurring, autoTask, taskBacklog, triggerType, debounceMs, readOnly, maxFires } = params;

      let trigger: Trigger;
      const inferred = triggerType ?? inferTriggerType(triggerInput);

      if (inferred === "cron") {
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
      if (validationError) return Promise.resolve(textResult(validationError));

      const entry = getStore().create(trigger, prompt, {
        recurring: recurring ?? (inferred !== "event"),
        autoTask,
        taskBacklog,
        readOnly,
        maxFires,
      });

      getTriggerSystem().add(entry);

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

      const triggerDesc = formatTrigger(trigger, "create");

      return Promise.resolve(textResult(
        `Loop #${entry.id} created: ${entry.prompt.slice(0, 60)}\n` +
        `Trigger: ${triggerDesc}\n` +
        `Recurring: ${entry.recurring}\n` +
        (entry.autoTask ? "Auto-create task: enabled\n" : "") +
        (entry.taskBacklog ? "Backlog worker: enabled\n" : "") +
        (bootstrapped ? "Backlog: initial wake queued for existing pending tasks\n" : "") +
        (isTaskSystemReady() ? "" : "Task system: not ready yet — autoTask may not fire until native fallback or pi-tasks becomes available\n") +
        `ID: ${entry.id} (persists until explicitly canceled or a configured stop condition is met)`
      ));
    },
  });

  pi.registerTool({
    name: "LoopList",
    label: "LoopList",
    description: `List all active scheduled loops with their IDs, triggers, and next-fire times.

Use this before creating new loops to avoid duplicates, or to find IDs for LoopDelete.`,
    parameters: Type.Object({}),
    execute() {
      const loops = getStore().list();
      if (loops.length === 0) return Promise.resolve(textResult("No loops configured. Use LoopCreate to set up a schedule."));

      const lines: string[] = [];
      for (const entry of loops) {
        const triggerDesc = formatTrigger(entry.trigger, "list");

        const nextFire = entry.trigger.type === "cron" || entry.trigger.type === "hybrid" || entry.dynamic?.nextWakeAt !== undefined ? getScheduler().nextFire(entry.id) : undefined;
        const statusIcon = entry.status === "active" ? "*" : entry.status === "paused" ? "-" : "x";
        let line = `${statusIcon} #${entry.id} [${entry.status}] ${entry.prompt.slice(0, 60)}`;
        line += ` (${triggerDesc})`;
        if (nextFire) {
          const remaining = Math.max(0, nextFire - Date.now());
          line += ` next: ${formatRemaining(remaining)}`;
        }
        if (entry.autoTask) line += " [auto-task]";
        if (entry.taskBacklog) line += " [backlog-worker]";
        lines.push(line);
      }

      return Promise.resolve(textResult(lines.join("\n")));
    },
  });

  pi.registerTool({
    name: "LoopUpdate",
    label: "LoopUpdate",
    description: `Update progress for a dynamic loop.

Use this exactly once after each dynamic loop wake. Mark status as "continue" with updated state/metrics and optional nextInterval whenever any work remains, "completed" only when the overall goal and done criteria are satisfied, or "paused" when genuinely blocked. Do not use LoopDelete to finish an iteration.`,
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
      if (!entry) return Promise.resolve(textResult(`Loop #${params.id} not found`));
      if (entry.trigger.type !== "dynamic" || !entry.dynamic) {
        return Promise.resolve(textResult(`Loop #${params.id} is not a dynamic loop`));
      }

      const message = params.status === "continue"
        ? continueDynamicLoop(params, entry as LoopEntry & { dynamic: NonNullable<LoopEntry["dynamic"]> }, store, triggerSystem)
        : stopDynamicLoop(params, store, triggerSystem);
      updateWidget();
      return Promise.resolve(textResult(message));
    },
  });

  pi.registerTool({
    name: "LoopDelete",
    label: "LoopDelete",
    description: `Delete or pause a loop by its ID.

Use "pause" to temporarily stop a loop without removing it. Use "delete" to permanently remove it.

Do not use this after a normal loop fire, an unchanged check, an empty iteration, or one step of a dynamic goal. Recurring loops remain active across iterations; dynamic loops use LoopUpdate. Delete only when the user explicitly asks to cancel the loop or its stated stop condition is satisfied.`,
    parameters: Type.Object({
      id: Type.String({ description: "Loop ID to delete or pause" }),
      action: Type.Optional(Type.String({ description: "delete or pause (default: delete)", enum: ["delete", "pause"], default: "delete" })),
    }),
    execute(_toolCallId, params) {
      const { id, action } = params;

      if (action === "pause") {
        const entry = getStore().pause(id);
        if (!entry) {
          const tombstone = getStore().getDeletionTombstone(id);
          if (tombstone) return Promise.resolve(textResult(formatDeletionTombstone(id, tombstone)));
          return Promise.resolve(textResult(`Loop #${id} not found`));
        }
        getTriggerSystem().remove(id);
        updateWidget();
        return Promise.resolve(textResult(`Loop #${id} paused`));
      }

      getTriggerSystem().remove(id);
      const deleted = getStore().delete(id);
      updateWidget();
      if (deleted) return Promise.resolve(textResult(`Loop #${id} deleted`));
      const tombstone = getStore().getDeletionTombstone(id);
      if (tombstone) return Promise.resolve(textResult(formatDeletionTombstone(id, tombstone)));
      return Promise.resolve(textResult(`Loop #${id} not found`));
    },
  });
}
