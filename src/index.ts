/**
 * @trevonistrevon/pi-loop — A pi extension providing cron/event-based agent re-wake loops and background process monitoring.
 *
 * Tools:
 *   LoopCreate    — Create a scheduled or event-triggered re-wake loop
 *   LoopList      — List all active loops with status and next-fire times
 *   LoopDelete    — Delete or pause a loop by ID
 *   MonitorCreate — Start a background command that streams output via pi events
 *   MonitorList   — List running monitors
 *   MonitorStop   — Stop a running monitor
 *
 * Commands:
 *   /loop    — Schedule a re-wake loop: /loop [interval] [prompt]
 *   /loops   — Interactive menu: view, create, cancel, settings
 */

import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { parseInterval } from "./loop-parse.js";
import { MonitorManager } from "./monitor-manager.js";
import { CronScheduler } from "./scheduler.js";
import { LoopStore } from "./store.js";
import { TaskStore } from "./task-store.js";
import { TriggerSystem } from "./trigger-system.js";
import type { LoopEntry, Trigger } from "./types.js";
import { LoopWidget } from "./ui/widget.js";

const DEBUG = !!process.env.PI_LOOP_DEBUG;
function debug(...args: unknown[]) {
  if (DEBUG) console.error("[pi-loop]", ...args);
}

function textResult(msg: string) {
  return { content: [{ type: "text" as const, text: msg }], details: undefined as any };
}

interface LoopFireEvent {
  loopId: string;
  prompt: string;
  trigger: Trigger | string;
  timestamp: number;
  readOnly?: boolean;
  recurring?: boolean;
  autoTask?: boolean;
}

interface SessionSwitchEvent {
  reason?: string;
}

interface PendingNotification extends LoopFireEvent {
  key: string;
  message: string;
}

export default function (pi: ExtensionAPI) {
  const piLoopEnv = process.env.PI_LOOP;
  const piLoopScope = process.env.PI_LOOP_SCOPE as "memory" | "session" | "project" | undefined;
  let loopScope: "memory" | "session" | "project" = piLoopScope ?? "session";

  function resolveStorePath(sessionId?: string): string | undefined {
    if (piLoopEnv === "off") return undefined;
    if (piLoopEnv?.startsWith("/")) return piLoopEnv;
    if (piLoopEnv?.startsWith(".")) return resolve(piLoopEnv);
    if (piLoopEnv) return piLoopEnv;
    if (loopScope === "memory") return undefined;
    if (loopScope === "session" && sessionId) {
      return join(process.cwd(), ".pi", "loops", `loops-${sessionId}.json`);
    }
    if (loopScope === "session") return undefined;
    return join(process.cwd(), ".pi", "loops", "loops.json");
  }

  function resolveTaskStorePath(sessionId?: string): string | undefined {
    if (loopScope === "memory") return undefined;
    if (loopScope === "session" && sessionId) {
      return join(process.cwd(), ".pi", "tasks", `tasks-${sessionId}.json`);
    }
    if (loopScope === "session") return undefined;
    return join(process.cwd(), ".pi", "tasks", "tasks.json");
  }

  let store = new LoopStore(resolveStorePath());
  const monitorManager = new MonitorManager(pi);
  let scheduler: CronScheduler;
  let triggerSystem: TriggerSystem;
  const widget = new LoopWidget(store, monitorManager);
  widget.setTaskSummaryProvider(() => {
    if (!nativeTaskStore) return { count: 0 };
    const tasks = nativeTaskStore.list().filter(t => t.status === "pending" || t.status === "in_progress");
    const active = tasks.find(t => t.status === "in_progress");
    const next = tasks.find(t => t.status === "pending");
    const focus = active
      ? `active: ${active.subject.slice(0, 50)}`
      : next
        ? `next: ${next.subject.slice(0, 50)}`
        : undefined;
    return { count: tasks.length, focusText: focus };
  });

  scheduler = new CronScheduler(store, onLoopFire);
  triggerSystem = new TriggerSystem(pi, scheduler, store, onLoopFire);

  // ── pi-tasks integration ──
  let tasksAvailable = false;
  let nativeTaskStore: TaskStore | undefined;
  let nativeTasksRegistered = false;

  function checkTasksVersion() {
    const requestId = randomUUID();
    const timer = setTimeout(() => { unsub(); }, 5000);
    const unsub = pi.events.on(`tasks:rpc:ping:reply:${requestId}`, (raw: unknown) => {
      unsub(); clearTimeout(timer);
      const remoteVersion = (raw as any)?.data?.version as number | undefined;
      if (remoteVersion !== undefined) tasksAvailable = true;
    });
    pi.events.emit("tasks:rpc:ping", { requestId });
  }

  checkTasksVersion();
  pi.events.on("tasks:ready", () => checkTasksVersion());

  async function autoCreateTask(entry: LoopEntry): Promise<string | undefined> {
    if (!entry.autoTask) return undefined;
    if (tasksAvailable) {
      try {
        const requestId = randomUUID();
        const taskId = await new Promise<string | undefined>((resolve, _reject) => {
          const timer = setTimeout(() => { unsub(); resolve(undefined); }, 5000);
          const unsub = pi.events.on(`tasks:rpc:create:reply:${requestId}`, (raw: unknown) => {
            unsub(); clearTimeout(timer);
            const reply = raw as { success: boolean; data?: { id: string }; error?: string };
            if (reply.success && reply.data) resolve(reply.data.id);
            else resolve(undefined);
          });
          pi.events.emit("tasks:rpc:create", {
            requestId,
            subject: entry.prompt.slice(0, 80),
            description: `Auto-created from loop #${entry.id}`,
            metadata: { loopId: entry.id, trigger: entry.trigger },
          });
        });
        return taskId;
      } catch {
        return undefined;
      }
    }
    if (!nativeTaskStore) return undefined;
    const task = nativeTaskStore.create(entry.prompt.slice(0, 80), `Auto-created from loop #${entry.id}`, {
      loopId: entry.id,
      trigger: entry.trigger,
    });
    widget.update();
    return task.id;
  }

  async function hasPendingTasks(): Promise<number> {
    if (tasksAvailable) {
      try {
        const requestId = randomUUID();
        const count = await new Promise<number>((resolve) => {
          const timer = setTimeout(() => { unsub(); resolve(-1); }, 3000);
          const unsub = pi.events.on(`tasks:rpc:pending:reply:${requestId}`, (raw: unknown) => {
            unsub(); clearTimeout(timer);
            const reply = raw as { success: boolean; data?: { pending: number }; error?: string };
            resolve(reply.success && reply.data ? reply.data.pending : -1);
          });
          pi.events.emit("tasks:rpc:pending", { requestId });
        });
        return count;
      } catch {
        return -1;
      }
    }
    return nativeTaskStore ? nativeTaskStore.pendingCount() : -1;
  }

  async function cleanDoneTasks(): Promise<void> {
    if (tasksAvailable) {
      try {
        const requestId = randomUUID();
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => { unsub(); resolve(); }, 3000);
          const unsub = pi.events.on(`tasks:rpc:clean:reply:${requestId}`, () => {
            unsub(); clearTimeout(timer);
            debug("tasks:rpc:clean — done tasks swept");
            resolve();
          });
          pi.events.emit("tasks:rpc:clean", { requestId });
        });
      } catch { /* timeout or error, ignore */ }
      return;
    }
    if (nativeTaskStore) {
      nativeTaskStore.sweepCompleted();
      widget.update();
    }
  }

  let agentRunning = false;
  const pendingNotifications = new Map<string, PendingNotification>();
  let flushPromise: Promise<void> | undefined;

  function buildLoopFireMessage(data: LoopFireEvent): string {
    const triggerInfo = typeof data.trigger === "string"
      ? data.trigger
      : data.trigger?.type === "cron"
        ? `schedule: ${data.trigger.schedule}`
        : data.trigger?.type === "event"
          ? `event: ${data.trigger.source}`
          : "hybrid";

    const loopId = data.loopId || "?";
    const prompt = data.prompt || "loop fired";
    const constraint = data.readOnly
      ? "\n\nREAD-ONLY MODE — use only read tools (Read, TaskList, LoopList, MonitorList, etc.). No file writes, shell execution, or destructive changes."
      : "";

    return [
      `[pi-loop] Loop #${loopId} fired (${triggerInfo}).${constraint}`,
      prompt,
    ].join("\n");
  }

  function buildPendingNotification(data: LoopFireEvent): PendingNotification {
    const key = data.recurring ? `loop:${data.loopId}` : `loop:${data.loopId}:${data.timestamp}`;
    return {
      ...data,
      key,
      message: buildLoopFireMessage(data),
    };
  }

  function triggerHasEventSource(trigger: Trigger | string, source: string): boolean {
    if (typeof trigger === "string") return false;
    return trigger.type === "event"
      ? trigger.source === source
      : trigger.type === "hybrid"
        ? trigger.event.source === source
        : false;
  }

  async function maybeBootstrapTaskLoop(entry: LoopEntry): Promise<boolean> {
    if (!entry.recurring) return false;
    if (!triggerHasEventSource(entry.trigger, "tasks:created")) return false;

    const pending = await hasPendingTasks();
    if (pending <= 0) return false;

    debug(`loop #${entry.id} — bootstrapping existing pending tasks (${pending})`);
    await queueOrDeliverNotification({
      loopId: entry.id,
      prompt: entry.prompt,
      trigger: entry.trigger,
      timestamp: Date.now(),
      readOnly: entry.readOnly,
      recurring: false,
      autoTask: true,
    });
    return true;
  }

  async function deliverNotification(notification: PendingNotification): Promise<boolean> {
    if (notification.autoTask) {
      const pending = await hasPendingTasks();
      if (pending === 0) {
        debug(`loop:fire #${notification.loopId} — no pending tasks at delivery time, dropping wake`);
        await cleanDoneTasks();
        return false;
      }
    }

    agentRunning = true;
    pi.sendMessage({
      customType: "pi-loop",
      content: notification.message,
      display: false,
      details: {
        loopId: notification.loopId,
        trigger: notification.trigger,
        recurring: notification.recurring,
        readOnly: notification.readOnly,
        autoTask: notification.autoTask,
        timestamp: notification.timestamp,
      },
    }, {
      deliverAs: "steer",
      triggerTurn: true,
    });
    return true;
  }

  async function flushPendingNotifications(): Promise<void> {
    if (flushPromise) return flushPromise;

    flushPromise = (async () => {
      if (agentRunning || _latestCtx?.hasPendingMessages()) return;

      const entries = [...pendingNotifications.entries()]
        .sort(([, left], [, right]) => left.timestamp - right.timestamp);

      for (const [key, notification] of entries) {
        pendingNotifications.delete(key);
        const delivered = await deliverNotification(notification);
        if (delivered) return;
      }
    })().finally(() => {
      flushPromise = undefined;
    });

    return flushPromise;
  }

  async function queueOrDeliverNotification(data: LoopFireEvent): Promise<void> {
    const notification = buildPendingNotification(data);
    pendingNotifications.set(notification.key, notification);
    await flushPendingNotifications();
  }

  // ── Loop fire handler ──

  function onLoopFire(entry: LoopEntry): void {
    debug(`loop:fire #${entry.id}`, { prompt: entry.prompt.slice(0, 50) });

    if (entry.maxFires && (entry.fireCount ?? 0) >= entry.maxFires) {
      debug(`loop #${entry.id} — reached maxFires ${entry.maxFires}, expiring`);
      store.delete(entry.id);
      return;
    }
    store.update(entry.id, { fireCount: (entry.fireCount ?? 0) + 1 });

    if (entry.autoTask) {
      autoCreateTask(entry).then((taskId) => {
        if (taskId) debug(`loop #${entry.id} → task #${taskId}`);
      });
    }

    pi.events.emit("loop:fire", {
      loopId: entry.id,
      prompt: entry.prompt,
      trigger: entry.trigger,
      timestamp: Date.now(),
      readOnly: entry.readOnly,
      recurring: entry.recurring,
      autoTask: entry.autoTask,
    });
  }

  // ── Session lifecycle ──

  let storeUpgraded = false;
  let persistedShown = false;
  let _latestCtx: ExtensionContext | undefined;
  let _sessionId: string | undefined;

  function upgradeStoreIfNeeded(ctx: ExtensionContext) {
    if (storeUpgraded) return;
    if (loopScope === "session" && !piLoopEnv) {
      const sessionId = ctx.sessionManager.getSessionId();
      const path = resolveStorePath(sessionId);
      store = new LoopStore(path);
      widget.setStore(store);
      scheduler = new CronScheduler(store, onLoopFire);
      triggerSystem = new TriggerSystem(pi, scheduler, store, onLoopFire);
    }
    storeUpgraded = true;
  }

  function showPersistedLoops(_isResume = false) {
    if (persistedShown) return;
    persistedShown = true;
    const sessionStartedAt = Date.now();
    const loops = store.list();
    if (loops.length > 0) {
      store.clearExpired();
      store.expireEventLoops(sessionStartedAt);
      triggerSystem.start();
      widget.update();
    }
  }

  pi.on("turn_start", async (_event, ctx) => {
    _latestCtx = ctx;
    _sessionId = ctx.sessionManager.getSessionId();
    widget.setUICtx(ctx.ui);
    upgradeStoreIfNeeded(ctx);
    widget.update();
    await pumpLoops();
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    _latestCtx = ctx;
    widget.setUICtx(ctx.ui);
    upgradeStoreIfNeeded(ctx);
    showPersistedLoops();
    widget.update();
  });

  pi.on("agent_start", async (_event, ctx) => {
    agentRunning = true;
    _latestCtx = ctx;
    widget.setUICtx(ctx.ui);
  });

  pi.on("agent_end", async (_event, ctx) => {
    agentRunning = false;
    _latestCtx = ctx;
    widget.setUICtx(ctx.ui);
    await flushPendingNotifications();
    await pumpLoops();
  });

  pi.on("session_shutdown", async () => {
    agentRunning = false;
    pendingNotifications.clear();
  });

  pi.on("session_switch" as any, async (event: SessionSwitchEvent, ctx: ExtensionContext) => {
    _latestCtx = ctx;
    widget.setUICtx(ctx.ui);
    triggerSystem.stop();
    agentRunning = false;
    pendingNotifications.clear();
    _sessionId = undefined;

    const isResume = event?.reason === "resume";
    storeUpgraded = false;
    persistedShown = false;

    if (!isResume && loopScope === "memory") {
      store.clearAll();
    }

    upgradeStoreIfNeeded(ctx);
    showPersistedLoops(isResume);
    widget.update();
  });

  // ── Dynamic loop pump — fires cron/hybrid loops on idle instead of wall-clock timers ──

  async function pumpLoops(): Promise<void> {
    const pendingTasks = new Map<string, boolean>();
    for (const entry of store.list()) {
      if (entry.status !== "active") continue;
      if (!entry.autoTask) continue;
      if (entry.trigger.type !== "cron" && entry.trigger.type !== "hybrid") continue;
      const nextFire = scheduler.nextFire(entry.id);
      if (!nextFire || Date.now() < nextFire) continue;
      const pending = await hasPendingTasks();
      if (pending <= 0) pendingTasks.set(entry.id, true);
    }
    scheduler.pump(Date.now(), (entry) => !pendingTasks.has(entry.id));
  }

  // ── Loop fire handler — queues an in-memory notification, then injects a custom message when delivery is safe ──

  pi.events.on("loop:fire", async (event: unknown) => {
    const data = event as LoopFireEvent;

    if (data.autoTask) {
      const pending = await hasPendingTasks();
      if (pending === 0) {
        debug(`loop:fire #${data.loopId} — no pending tasks, skipping, requesting cleanup`);
        await cleanDoneTasks();
        return;
      }
    }

    await queueOrDeliverNotification(data);
  });

  // ──────────────────────────────────────────────────
  // Tool 1: LoopCreate
  // ──────────────────────────────────────────────────

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
- **readOnly**: restrict the agent to read-only tools when this loop fires (default: false)
- **maxFires**: auto-stop after N fires — prevents infinite token burn on polling loops`,
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
      "When a loop fires and finds nothing to do, call LoopDelete on its own ID to stop it — don't keep polling.",
      "## readOnly mode",
      "Set readOnly: true for loops that only observe and report (checks, status polls). This prevents unintended changes.",
      "## Task-driven workflows",
      "Do not rely on a past 'tasks:created' event to replay. If tasks already exist, bootstrap the first pass in the current turn or use a hybrid/event loop that can catch future task creation and a cron safety-net.",
      "Use autoTask only when you want the loop itself to create a task on each fire. For processing an existing task backlog, leave autoTask off and have the loop run TaskList to pick the next pending task.",
      "When no tasks are pending, the loop should stop itself or skip the wake entirely — no tokens burned on empty polls.",
      "After creating a loop, tell the user the loop ID so they can cancel it with LoopDelete.",
    ],
    parameters: Type.Object({
      trigger: Type.String({ description: "Cron expression (e.g., '5m', '1h', '0 9 * * 1-5'), event source (e.g., 'tool_execution_start'), or JSON hybrid spec" }),
      prompt: Type.String({ description: "Prompt to run when the loop fires" }),
      recurring: Type.Optional(Type.Boolean({ description: "Whether loop repeats (default: true)", default: true })),
      autoTask: Type.Optional(Type.Boolean({ description: "Auto-create pi-tasks task on fire", default: false })),
      triggerType: Type.Optional(Type.String({ description: "cron, event, or hybrid (inferred from trigger string if omitted)", enum: ["cron", "event", "hybrid"] })),
      debounceMs: Type.Optional(Type.Number({ description: "Debounce for hybrid triggers (default: 30000)", default: 30000 })),
      readOnly: Type.Optional(Type.Boolean({ description: "Restrict the agent to read-only tools when this loop fires (default: false)", default: false })),
      maxFires: Type.Optional(Type.Number({ description: "Auto-stop after N fires. Prevents infinite token burn on polling loops." })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { trigger: triggerInput, prompt, recurring, autoTask, triggerType, debounceMs, readOnly, maxFires } = params;

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

      const entry = store.create(trigger, prompt, {
        recurring: recurring ?? (inferred !== "event"),
        autoTask,
        readOnly,
        maxFires,
      });

      triggerSystem.add(entry);

      if (trigger.type === "event" && trigger.source === "monitor:done" && trigger.filter) {
        try {
          const filterObj = JSON.parse(trigger.filter);
          const monitorId = filterObj.monitorId as string | undefined;
          if (monitorId) {
            const monitor = monitorManager.get(monitorId);
            if (monitor && monitor.status !== "running") {
              debug(`loop #${entry.id} — monitor #${monitorId} already ${monitor.status}, expiring`);
              triggerSystem.remove(entry.id);
              store.delete(entry.id);
            }
          }
        } catch { /* filter parse failure, ignore */ }
      }

      const bootstrapped = await maybeBootstrapTaskLoop(entry);

      widget.update();

      const triggerDesc = trigger.type === "cron"
        ? `schedule: ${trigger.schedule}`
        : trigger.type === "event"
          ? `event: ${trigger.source}`
          : `hybrid: cron ${trigger.cron} + event ${trigger.event.source}`;

      return Promise.resolve(textResult(
        `Loop #${entry.id} created: ${entry.prompt.slice(0, 60)}\n` +
        `Trigger: ${triggerDesc}\n` +
        `Recurring: ${entry.recurring}\n` +
        (entry.autoTask ? `Auto-task: enabled\n` : "") +
        (bootstrapped ? "Bootstrap: queued initial wake for existing pending tasks\n" : "") +
        ((tasksAvailable || nativeTasksRegistered) ? "" : "(task system not ready yet — autoTask may not fire until native fallback or pi-tasks becomes available)\n") +
        `ID: ${entry.id} (use LoopDelete to cancel)`
      ));
    },
  });

  function handleMonitorDoneLoop(doneLoop: LoopEntry, monitorId: string): void {
    triggerSystem.add(doneLoop);
    const monitor = monitorManager.get(monitorId);
    if (monitor && monitor.status !== "running") {
      debug(`onDone loop #${doneLoop.id} — monitor #${monitorId} already ${monitor.status}, expiring`);
      triggerSystem.remove(doneLoop.id);
      store.delete(doneLoop.id);
    }
  }

  function validateTrigger(trigger: Trigger): string | null {
    if (trigger.type === "cron") {
      const parts = trigger.schedule.trim().split(/\s+/);
      if (parts.length !== 5) {
        return `Invalid cron trigger. Expected 5 fields, got ${parts.length}: "${trigger.schedule}". Use formats like "5m", "1h", "0 9 * * 1-5", or set triggerType to "event" for event sources.`;
      }
    } else if (trigger.type === "event") {
      if (!trigger.source || trigger.source.trim().length === 0) {
        return `Invalid event trigger. Event source must be non-empty (e.g., "tool_execution_start").`;
      }
    } else if (trigger.type === "hybrid") {
      const cronParts = trigger.cron.trim().split(/\s+/);
      if (cronParts.length !== 5) {
        return `Invalid hybrid trigger. Cron part must have 5 fields, got ${cronParts.length}: "${trigger.cron}".`;
      }
      if (!trigger.event.source || trigger.event.source.trim().length === 0) {
        return `Invalid hybrid trigger. Event source must be non-empty (e.g., "tool_execution_start").`;
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

  // ──────────────────────────────────────────────────
  // Tool 2: LoopList
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "LoopList",
    label: "LoopList",
    description: `List all active scheduled loops with their IDs, triggers, and next-fire times.

Use this before creating new loops to avoid duplicates, or to find IDs for LoopDelete.`,
    parameters: Type.Object({}),

    execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const loops = store.list();
      if (loops.length === 0) return Promise.resolve(textResult("No loops configured. Use LoopCreate to set up a schedule."));

      const lines: string[] = [];
      for (const entry of loops) {
        const triggerDesc = entry.trigger.type === "cron"
          ? `cron: ${entry.trigger.schedule}`
          : entry.trigger.type === "event"
            ? `event: ${entry.trigger.source}`
            : `hybrid: ${entry.trigger.cron} + ${entry.trigger.event.source}`;

        const nextFire = entry.trigger.type !== "event"
          ? scheduler.nextFire(entry.id)
          : undefined;

        const statusIcon = entry.status === "active" ? "*" : entry.status === "paused" ? "-" : "x";
        let line = `${statusIcon} #${entry.id} [${entry.status}] ${entry.prompt.slice(0, 60)}`;
        line += ` (${triggerDesc})`;
        if (nextFire) {
          const remaining = Math.max(0, nextFire - Date.now());
          line += ` next: ${formatRemaining(remaining)}`;
        }
        if (entry.autoTask) line += " [auto-task]";
        lines.push(line);
      }

      return Promise.resolve(textResult(lines.join("\n")));
    },
  });

  function formatRemaining(ms: number): string {
    if (ms < 60000) return `${Math.round(ms / 1000)}s`;
    if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
    return `${Math.round(ms / 3600000)}h`;
  }

  // ──────────────────────────────────────────────────
  // Tool 3: LoopDelete
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "LoopDelete",
    label: "LoopDelete",
    description: `Delete or pause a loop by its ID.

Use "pause" to temporarily stop a loop without removing it. Use "delete" to permanently remove it.`,
    parameters: Type.Object({
      id: Type.String({ description: "Loop ID to delete or pause" }),
      action: Type.Optional(Type.String({ description: "delete or pause (default: delete)", enum: ["delete", "pause"], default: "delete" })),
    }),

    execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { id, action } = params;

      if (action === "pause") {
        const result = store.update(id, { status: "paused" });
        if (!result.entry) return Promise.resolve(textResult(`Loop #${id} not found`));
        triggerSystem.remove(id);
        widget.update();
        return Promise.resolve(textResult(`Loop #${id} paused`));
      }

      triggerSystem.remove(id);
      const deleted = store.delete(id);
      widget.update();
      if (deleted) return Promise.resolve(textResult(`Loop #${id} deleted`));
      return Promise.resolve(textResult(`Loop #${id} not found`));
    },
  });

  // ──────────────────────────────────────────────────
  // Tool 4: MonitorCreate
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "MonitorCreate",
    label: "MonitorCreate",
    description: `Run a shell command in the background and get notified when it finishes. The core tool for async/parallel work.

Fire off a build check, CI monitor, experiment, script, or any slow command — then keep working. Output streams back as "monitor:output" events. When the process exits, "monitor:done" fires (or "monitor:error" on failure).

If you pass onDone with a prompt, the monitor auto-creates a one-shot completion loop — you get a completion wake with the exit code and output line count. No need to poll or create a separate loop.

DO NOT use raw Bash while/sleep/for loops to watch something. DO NOT run slow commands inline that could be offloaded. Use MonitorCreate to run work in parallel while you continue.

## When to Use

Default to MonitorCreate for any long-running or background work:\n- Watch a CI/CD build (hut, gh, curl polling) while you work on something else\n- Run experiments, benchmarks, or training scripts in parallel\n- Tail a log or poll an API endpoint\n- Fire off a slow curl/fetch and check the result later\n- Run any script or command you don't need to wait on inline

## Events emitted

- "monitor:output" — { monitorId, line, timestamp } for each output line\n- "monitor:done" — { monitorId, exitCode, outputLines } on clean exit\n- "monitor:error" — { monitorId, error } on failure

## onDone — auto-notify on completion

Pass onDone with a prompt and the monitor auto-creates a one-shot loop that fires when the process exits. The completion wake includes the exit code and output line count.\n\nExample: MonitorCreate command="python train.py" onDone="Check training results and report best loss"\nExample: MonitorCreate command="hut builds show 1769753" onDone="Analyze the build result and report status"`,
    promptGuidelines: [
      "Default to MonitorCreate for any long-running or background command — releases the agent to keep working on other tasks in parallel.",
      "When the user asks to monitor CI builds, watch a build, check a remote job, or run an experiment, use MonitorCreate instead of inline bash/curl/wait.",
      "Use onDone to auto-notify when a background command finishes — the agent will pick up the results automatically.",
    ],
    parameters: Type.Object({
      command: Type.String({ description: "Shell command to run in background" }),
      description: Type.Optional(Type.String({ description: "Human-readable description" })),
      timeout: Type.Optional(Type.Number({ description: "Auto-stop after N ms (default: 300000, 0 = no timeout)", default: 300000 })),
      onDone: Type.Optional(Type.String({ description: "Prompt to run when the monitor completes. Auto-creates a one-shot completion wake — no need for a separate LoopCreate." })),
    }),

    execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (monitorManager.list().filter(m => m.status === "running").length >= 25) {
        return Promise.resolve(textResult("Maximum of 25 running monitors reached. Stop some before creating new ones."));
      }

      const entry = monitorManager.create(params.command, params.description, params.timeout);
      widget.update();

      let onDoneMsg = "";
      if (params.onDone) {
        const doneTrigger: Trigger = { type: "event", source: "monitor:done", filter: JSON.stringify({ monitorId: entry.id }) };
        const doneLoop = store.create(doneTrigger, params.onDone, { recurring: false });
        handleMonitorDoneLoop(doneLoop, entry.id);
        onDoneMsg = `\nonDone loop #${doneLoop.id}: fires when monitor completes — no polling needed`;
      }

      return Promise.resolve(textResult(
        `Monitor #${entry.id} started: ${entry.command.slice(0, 60)}\n` +
        `Output stream: monitor:output (monitorId: ${entry.id})\n` +
        `Timeout: ${params.timeout ? `${params.timeout / 1000}s` : "none"}${onDoneMsg}`
      ));
    },
  });

  // ──────────────────────────────────────────────────
  // Tool 5: MonitorList
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "MonitorList",
    label: "MonitorList",
    description: `List all monitors with their status, command, exit code, output line count, and last 5 lines of buffered output.`,
    parameters: Type.Object({}),

    execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const monitors = monitorManager.list();
      if (monitors.length === 0) return Promise.resolve(textResult("No monitors running."));

      const lines: string[] = [];
      for (const m of monitors) {
        const icon = m.status === "running" ? ">" : m.status === "completed" ? "ok" : "!!";
        const age = Date.now() - m.startedAt;
        const ageStr = formatRemaining(age);
        let line = `${icon} #${m.id} [${m.status}] ${m.command.slice(0, 60)} — ${m.outputLines} lines (${ageStr})`;
        if (m.exitCode !== undefined) line += ` exit=${m.exitCode}`;
        lines.push(line);

        if (m.status !== "running" && m.outputBuffer.length > 0) {
          const tail = m.outputBuffer.slice(-5);
          for (const out of tail) {
            lines.push(`  | ${out.slice(0, 100)}`);
          }
        }
      }

      return Promise.resolve(textResult(lines.join("\n")));
    },
  });

  // ──────────────────────────────────────────────────
  // Tool 6: MonitorStop
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "MonitorStop",
    label: "MonitorStop",
    description: `Stop a running monitor. Sends SIGTERM, waits 5s, then SIGKILL.

Use MonitorList to find the monitor ID, then stop it with this tool.`,
    parameters: Type.Object({
      monitorId: Type.String({ description: "Monitor ID to stop" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const stopped = await monitorManager.stop(params.monitorId);
      widget.update();
      if (stopped) return textResult(`Monitor #${params.monitorId} stopped`);
      return textResult(`Monitor #${params.monitorId} not found or not running`);
    },
  });

  // ──────────────────────────────────────────────────
  // /loop command
  // ──────────────────────────────────────────────────

  pi.registerCommand("loop", {
    description: "Create a repeating scheduled task: /loop [interval] [prompt]. E.g., /loop 5m check the deploy, /loop 30s am I still here",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const trimmed = args.trim();
      const ui = ctx.ui;

      if (!trimmed) {
        const choice = await ui.select("Loop", [
          "Create scheduled loop",
          "Create event-triggered loop",
          "View active loops",
          "Settings",
        ]);

        if (!choice) return;
        if (choice.startsWith("Create scheduled")) return scheduleLoop(ui);
        if (choice.startsWith("Create event")) return eventLoop(ui);
        if (choice.startsWith("View active")) return viewLoops(ui);
        return settings(ui);
      }

      const intervalMatch = trimmed.match(/^(\d+\s*[smhdS]\b)/i);
      if (intervalMatch) {
        const interval = intervalMatch[1];
        const prompt = trimmed.slice(intervalMatch[0].length).trim();

        if (!prompt) {
          ui.notify("Provide a prompt after the interval, e.g., /loop 5m check the deploy", "warning");
          return;
        }

        try {
          const parsed = parseInterval(interval);
          const trigger: Trigger = { type: "cron", schedule: parsed.cron };
          const entry = store.create(trigger, prompt, { recurring: true });
          triggerSystem.add(entry);
          widget.update();
          ui.notify(`Loop #${entry.id} created: every ${parsed.description} — ${prompt.slice(0, 50)}`, "info");
        } catch (err: unknown) {
          ui.notify((err as Error).message, "error");
        }
        return;
      }

      const choice = await ui.select("Loop mode", [
        `Scheduled: "${trimmed.slice(0, 50)}"`,
        `Event-triggered: "${trimmed.slice(0, 50)}"`,
        `Self-paced: "${trimmed.slice(0, 50)}"`,
      ]);

      if (!choice) return;
      if (choice.startsWith("Event")) return eventLoop(ui, trimmed);
      return scheduleLoop(ui, trimmed);
    },
  });

  async function scheduleLoop(ui: ExtensionUIContext, prompt?: string) {
    const p = prompt || await ui.input("Prompt (what should the agent check?)");
    if (!p) return;

    const interval = await ui.input("Interval (e.g., 5m, 2h, 1d)");
    if (!interval) return;

    try {
      const parsed = parseInterval(interval);
      const trigger: Trigger = { type: "cron", schedule: parsed.cron };
      const entry = store.create(trigger, p, { recurring: true });
      triggerSystem.add(entry);
      widget.update();
      ui.notify(`Loop #${entry.id} created: every ${parsed.description}`, "info");
    } catch (err: unknown) {
      ui.notify((err as Error).message, "error");
    }
  }

  async function eventLoop(ui: ExtensionUIContext, prompt?: string) {
    const p = prompt || await ui.input("Prompt");
    if (!p) return;

    const source = await ui.input("Pi event source (e.g., tool_execution_start, before_agent_start)");
    if (!source) return;

    const trigger: Trigger = { type: "event", source };
    const entry = store.create(trigger, p, { recurring: true });
    triggerSystem.add(entry);
    widget.update();
    ui.notify(`Event loop #${entry.id} created: fires on "${source}"`, "info");
  }

  async function viewLoops(ui: ExtensionUIContext) {
    const loops = store.list();
    if (loops.length === 0) {
      await ui.select("No active loops", ["< Back"]);
      return;
    }

    const choices = loops.map((l: LoopEntry) => {
      const icon = l.status === "active" ? "*" : l.status === "paused" ? "-" : "x";
      const triggerDesc = l.trigger.type === "cron" ? `cron: ${l.trigger.schedule}` : l.trigger.type === "event" ? `event: ${l.trigger.source}` : `hybrid: ${l.trigger.cron}`;
      return `${icon} #${l.id} [${l.status}] ${l.prompt.slice(0, 50)} (${triggerDesc})`;
    });
    choices.push("< Back");

    const selected = await ui.select("Active Loops", choices);
    if (!selected || selected === "< Back") return;

    const match = selected.match(/#(\d+)/);
    if (match) {
      const entry = store.get(match[1]);
      if (entry) {
        const actions = ["x Delete"];
        if (entry.status === "active") actions.unshift("- Pause");
        else if (entry.status === "paused") actions.unshift("* Resume");
        actions.push("< Back");

        const action = await ui.select(
          `#${entry.id}: ${entry.prompt}\nTrigger: ${JSON.stringify(entry.trigger)}`,
          actions,
        );

        if (action === "x Delete") {
          triggerSystem.remove(entry.id);
          store.delete(entry.id);
          widget.update();
          ui.notify(`Loop #${entry.id} deleted`, "info");
        } else if (action === "- Pause") {
          store.update(entry.id, { status: "paused" });
          triggerSystem.remove(entry.id);
          widget.update();
          ui.notify(`Loop #${entry.id} paused`, "info");
        } else if (action === "* Resume") {
          store.update(entry.id, { status: "active" });
          triggerSystem.add(entry);
          widget.update();
          ui.notify(`Loop #${entry.id} resumed`, "info");
        }
      }
    }

    return viewLoops(ui);
  }

  async function settings(ui: ExtensionUIContext) {
    const loops = store.list();
    const active = loops.filter(l => l.status === "active").length;
    ui.notify(`${active}/${loops.length} active loops (max 25)`, "info");
  }

  async function createNativeTaskInteractively(ui: ExtensionUIContext) {
    if (!nativeTaskStore) {
      ui.notify("Native tasks are unavailable while pi-tasks is active", "warning");
      return;
    }

    const subject = await ui.input("Task subject");
    if (!subject) return;
    const description = await ui.input("Task description") || subject;
    const entry = nativeTaskStore.create(subject, description);
    widget.update();
    ui.notify(`Task #${entry.id} created`, "info");
  }

  async function viewNativeTasks(ui: ExtensionUIContext): Promise<void> {
    if (!nativeTaskStore) {
      ui.notify("Native tasks are unavailable while pi-tasks is active", "warning");
      return;
    }

    const tasks = nativeTaskStore.list();
    const choices = tasks.map((task) => {
      const icon = task.status === "in_progress" ? ">" : task.status === "completed" ? "ok" : "*";
      return `${icon} #${task.id} [${task.status}] ${task.subject.slice(0, 60)}`;
    });
    choices.unshift("+ Create task");
    choices.push("< Back");

    const selected = await ui.select("Native Tasks", choices);
    if (!selected || selected === "< Back") return;
    if (selected === "+ Create task") {
      await createNativeTaskInteractively(ui);
      return viewNativeTasks(ui);
    }

    const match = selected.match(/#(\d+)/);
    if (!match) return viewNativeTasks(ui);

    const task = nativeTaskStore.get(match[1]);
    if (!task) return viewNativeTasks(ui);

    const actions = ["x Delete"];
    if (task.status === "pending") {
      actions.unshift("ok Complete");
      actions.unshift("> Start");
    } else if (task.status === "in_progress") {
      actions.unshift("ok Complete");
      actions.unshift("* Return to pending");
    } else {
      actions.unshift("* Reopen");
    }
    actions.push("< Back");

    const action = await ui.select(`#${task.id}: ${task.subject}\n\n${task.description}`, actions);
    if (!action || action === "< Back") return viewNativeTasks(ui);

    if (action === "x Delete") {
      nativeTaskStore.delete(task.id);
      ui.notify(`Task #${task.id} deleted`, "info");
    } else if (action === "> Start") {
      nativeTaskStore.update(task.id, { status: "in_progress" });
      ui.notify(`Task #${task.id} started`, "info");
    } else if (action === "ok Complete") {
      nativeTaskStore.update(task.id, { status: "completed" });
      ui.notify(`Task #${task.id} completed`, "info");
    } else if (action === "* Return to pending" || action === "* Reopen") {
      nativeTaskStore.update(task.id, { status: "pending" });
      ui.notify(`Task #${task.id} reopened`, "info");
    }

    widget.update();
    return viewNativeTasks(ui);
  }

  // ── Native task tools (only when pi-tasks is absent) ──

  setTimeout(async () => {
    if (tasksAvailable || nativeTasksRegistered) return;
    nativeTaskStore = new TaskStore(resolveTaskStorePath(_sessionId));
    nativeTasksRegistered = true;
    const taskStore = nativeTaskStore;

    pi.registerCommand("tasks", {
      description: "View or manage native pi-loop tasks when pi-tasks is not installed",
      handler: async (args: string, ctx: ExtensionCommandContext) => {
        const trimmed = args.trim();
        if (!nativeTaskStore) {
          ctx.ui.notify("Native tasks are unavailable while pi-tasks is active", "warning");
          return;
        }
        if (trimmed) {
          const entry = nativeTaskStore.create(trimmed.slice(0, 80), trimmed);
          pi.events.emit("tasks:created", {
            taskId: entry.id,
            subject: entry.subject,
            description: entry.description,
            status: entry.status,
          });
          widget.update();
          ctx.ui.notify(`Task #${entry.id} created`, "info");
          return;
        }
        await viewNativeTasks(ctx.ui);
      },
    });

    pi.registerTool({
      name: "TaskCreate",
      label: "TaskCreate",
      description: `Create a task for tracking work across turns. Use when you need to track progress on complex multi-step tasks.

Fields:
- subject: brief actionable title
- description: detailed requirements
- metadata: optional tags/metadata`,
      promptGuidelines: [
        "Use TaskCreate to track complex multi-step work across turns.",
        "Break work into small, independently completable tasks. A task should be finishable in one focused session — if a task would take multiple turns, split it further.",
        "TaskCreate accepts `subject` and `description` parameters only — do not invent extra fields unless the schema explicitly adds them.",
      ],
      parameters: Type.Object({
        subject: Type.String({ description: "Brief actionable title for the task" }),
        description: Type.String({ description: "Detailed description of what needs to be done" }),
      }),
      execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
        const entry = taskStore.create(params.subject, params.description);
        pi.events.emit("tasks:created", {
          taskId: entry.id,
          subject: entry.subject,
          description: entry.description,
          status: entry.status,
        });
        widget.update();

        const pending = taskStore.pendingCount();
        const hint = pending >= 5
          ? `\n(${pending} pending tasks — consider creating a worker loop: LoopCreate trigger='tasks:created' recurring: true maxFires: 30 prompt='Run TaskList, pick next pending task, mark it in_progress, implement it, run validation, complete it. If no pending tasks remain, call LoopDelete on your own loop ID.')`
          : "";
        return Promise.resolve(textResult(`Task #${entry.id} created: ${entry.subject}${hint}`));
      },
    });

    pi.registerTool({
      name: "TaskList",
      label: "TaskList",
      description: `List all tasks with status. Use to check progress and find available work.`,
      parameters: Type.Object({}),
      execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
        const tasks = taskStore.list();
        if (tasks.length === 0) return Promise.resolve(textResult("No tasks."));

        const lines: string[] = [];
        const statuses: Record<"pending" | "in_progress" | "completed", number> = {
          pending: 0,
          in_progress: 0,
          completed: 0,
        };
        for (const t of tasks) {
          statuses[t.status]++;
          const icon = t.status === "completed" ? "ok" : t.status === "in_progress" ? ">" : "*";
          lines.push(`${icon} #${t.id} [${t.status}] ${t.subject.slice(0, 80)}`);
        }
        lines.unshift(`${tasks.length} tasks (${statuses.pending} pending, ${statuses.in_progress} in progress, ${statuses.completed} done)`);
        return Promise.resolve(textResult(lines.join("\n")));
      },
    });

    pi.registerTool({
      name: "TaskUpdate",
      label: "TaskUpdate",
      description: `Update task status or details. Set status to "in_progress" before starting work, "completed" when done.

Statuses: pending → in_progress → completed
Parameters: id (required), status, subject, description`,
      promptGuidelines: [
        "TaskUpdate uses parameter `id`, not `taskId`.",
        "Accepted parameters: `id` (required), `status`, `subject`, `description`.",
        "When validation fails with 'must have required properties id', you passed `taskId` instead of `id`. Correct silently and retry.",
      ],
      parameters: Type.Object({
        id: Type.String({ description: "Task ID to update" }),
        status: Type.Optional(Type.String({ description: "New status", enum: ["pending", "in_progress", "completed"] })),
        subject: Type.Optional(Type.String({ description: "New title" })),
        description: Type.Optional(Type.String({ description: "New description" })),
      }),
      execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
        const { id, status, subject, description } = params;
        const entry = taskStore.update(id, {
          status: status as "pending" | "in_progress" | "completed" | undefined,
          subject,
          description,
        });
        if (!entry) return Promise.resolve(textResult(`Task #${id} not found`));
        widget.update();
        const statusMsg = status ? ` → ${status}` : "";
        return Promise.resolve(textResult(`Task #${id} updated${statusMsg}`));
      },
    });

    pi.registerTool({
      name: "TaskDelete",
      label: "TaskDelete",
      description: `Delete a task by ID. Use for cleaning up completed or irrelevant tasks.`,
      parameters: Type.Object({
        id: Type.String({ description: "Task ID to delete" }),
      }),
      execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
        const deleted = taskStore.delete(params.id);
        widget.update();
        if (deleted) return Promise.resolve(textResult(`Task #${params.id} deleted`));
        return Promise.resolve(textResult(`Task #${params.id} not found`));
      },
    });

    debug("native task tools registered (pi-tasks not detected)");
  }, 6000);
}
