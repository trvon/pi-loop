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
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { parseInterval } from "./loop-parse.js";
import { MonitorManager } from "./monitor-manager.js";
import { CronScheduler } from "./scheduler.js";
import { LoopStore } from "./store.js";
import { TriggerSystem } from "./trigger-system.js";
import type { LoopEntry, Trigger } from "./types.js";
import { LoopWidget, type UICtx } from "./ui/widget.js";

const DEBUG = !!process.env.PI_LOOP_DEBUG;
function debug(...args: unknown[]) {
  if (DEBUG) console.error("[pi-loop]", ...args);
}

function textResult(msg: string) {
  return { content: [{ type: "text" as const, text: msg }], details: undefined as any };
}

const LOOP_TOOL_NAMES = new Set(["LoopCreate", "LoopList", "LoopDelete", "MonitorCreate", "MonitorList", "MonitorStop"]);
const REMINDER_INTERVAL = 3;

const SYSTEM_REMINDER_TEMPLATE = `<system-reminder>
Scheduled loop "%propmpt%" fired. Trigger: %trigger_info%.
[loop:%loop_id%]
</system-reminder>`;

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

  let store = new LoopStore(resolveStorePath());
  const monitorManager = new MonitorManager(pi);
  let scheduler: CronScheduler;
  let triggerSystem: TriggerSystem;
  const widget = new LoopWidget(store, undefined, monitorManager);

  scheduler = new CronScheduler(store, onLoopFire);
  widget.setScheduler(scheduler);
  triggerSystem = new TriggerSystem(pi, scheduler, store);

  // ── pi-tasks integration ──
  let tasksAvailable = false;
  const _PROTOCOL_VERSION = 1;

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
    if (!tasksAvailable || !entry.autoTask) return undefined;
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

  // ── Loop fire handler ──

  function onLoopFire(entry: LoopEntry): void {
    debug(`loop:fire #${entry.id}`, { prompt: entry.prompt.slice(0, 50) });

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
    });
  }

  // ── Session lifecycle ──

  let storeUpgraded = false;
  let persistedShown = false;
  let _latestCtx: ExtensionContext | undefined;

  function upgradeStoreIfNeeded(ctx: ExtensionContext) {
    if (storeUpgraded) return;
    if (loopScope === "session" && !piLoopEnv) {
      const sessionId = ctx.sessionManager.getSessionId();
      const path = resolveStorePath(sessionId);
      store = new LoopStore(path);
      widget.setStore(store);
      scheduler = new CronScheduler(store, onLoopFire);
      widget.setScheduler(scheduler);
      triggerSystem = new TriggerSystem(pi, scheduler, store);
    }
    storeUpgraded = true;
  }

  function showPersistedLoops(_isResume = false) {
    if (persistedShown) return;
    persistedShown = true;
    const loops = store.list();
    if (loops.length > 0) {
      store.clearExpired();
      store.expireEventLoops();
      triggerSystem.start();
      widget.update();
    }
  }

  pi.on("turn_start", async (_event, ctx) => {
    _latestCtx = ctx;
    widget.setUICtx(ctx.ui as UICtx);
    upgradeStoreIfNeeded(ctx);
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    _latestCtx = ctx;
    widget.setUICtx(ctx.ui as UICtx);
    upgradeStoreIfNeeded(ctx);
    showPersistedLoops();
  });

  pi.on("session_switch" as any, async (event: any, ctx: ExtensionContext) => {
    _latestCtx = ctx;
    widget.setUICtx(ctx.ui as UICtx);
    triggerSystem.stop();

    const isResume = event?.reason === "resume";
    storeUpgraded = false;
    persistedShown = false;

    if (!isResume && loopScope === "memory") {
      store.clearAll();
    }

    upgradeStoreIfNeeded(ctx);
    showPersistedLoops(isResume);
  });

  // ── System-reminder injection for loop fires ──

  let currentTurn = 0;
  let lastLoopToolUseTurn = 0;
  let reminderInjectedThisCycle = false;
  const pendingReminders: string[] = [];

  pi.on("loop:fire" as any, (data: any) => {
    const triggerInfo = typeof data.trigger === "string"
      ? data.trigger
      : data.trigger?.type === "cron"
        ? `schedule: ${data.trigger.schedule}`
        : data.trigger?.type === "event"
          ? `event: ${data.trigger.source}`
          : `hybrid`;

    const reminder = SYSTEM_REMINDER_TEMPLATE
      .replace("%prompt%", data.prompt || "loop fired")
      .replace("%trigger_info%", triggerInfo)
      .replace("%loop_id%", data.loopId || "unknown");

    pendingReminders.push(reminder);
  });

  pi.on("turn_start", async () => {
    currentTurn++;
  });

  pi.on("tool_result", async (event) => {
    if (LOOP_TOOL_NAMES.has(event.toolName)) {
      lastLoopToolUseTurn = currentTurn;
      reminderInjectedThisCycle = false;
      return {};
    }

    if (currentTurn - lastLoopToolUseTurn < REMINDER_INTERVAL || reminderInjectedThisCycle) {
      return {};
    }

    if (pendingReminders.length === 0) return {};

    reminderInjectedThisCycle = true;
    lastLoopToolUseTurn = currentTurn;
    const reminder = pendingReminders.shift()!;
    return {
      content: [...event.content, { type: "text" as const, text: reminder }],
    };
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
- **autoTask**: if pi-tasks is loaded, auto-create a task on each fire
- **triggerType**: "cron", "event", or "hybrid" (inferred if omitted)`,
    promptGuidelines: [
      "When the user asks for a loop, repeating task, periodic check, or scheduled reminder, use LoopCreate — not raw Bash for/sleep/while.",
      "Use LoopCreate for any 'every X seconds/minutes/hours' requests.",
      "After creating a loop, tell the user the loop ID so they can cancel it with LoopDelete.",
    ],
    parameters: Type.Object({
      trigger: Type.String({ description: "Cron expression (e.g., '5m', '1h', '0 9 * * 1-5'), event source (e.g., 'tool_execution_start'), or JSON hybrid spec" }),
      prompt: Type.String({ description: "Prompt to run when the loop fires" }),
      recurring: Type.Optional(Type.Boolean({ description: "Whether loop repeats (default: true)", default: true })),
      autoTask: Type.Optional(Type.Boolean({ description: "Auto-create pi-tasks task on fire", default: false })),
      triggerType: Type.Optional(Type.String({ description: "cron, event, or hybrid (inferred from trigger string if omitted)", enum: ["cron", "event", "hybrid"] })),
      debounceMs: Type.Optional(Type.Number({ description: "Debounce for hybrid triggers (default: 30000)", default: 30000 })),
    }),

    execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { trigger: triggerInput, prompt, recurring, autoTask, triggerType, debounceMs } = params;

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

      const entry = store.create(trigger, prompt, {
        recurring: recurring ?? (inferred !== "event"),
        autoTask,
        selfPaced: triggerInput === "self-paced" || prompt.toLowerCase().includes("self-paced"),
      });

      triggerSystem.add(entry);
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
        (tasksAvailable ? "" : "(pi-tasks not detected — autoTask will have no effect)\n") +
        `ID: ${entry.id} (use LoopDelete to cancel)`
      ));
    },
  });

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

        const statusIcon = entry.status === "active" ? "⟳" : entry.status === "paused" ? "⏸" : "✗";
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

If you pass onDone with a prompt, the monitor auto-creates a one-shot completion loop — you get a system reminder with the exit code and output line count. No need to poll or create a separate loop.

DO NOT use raw Bash while/sleep/for loops to watch something. DO NOT run slow commands inline that could be offloaded. Use MonitorCreate to run work in parallel while you continue.

## When to Use

Default to MonitorCreate for any long-running or background work:\n- Watch a CI/CD build (hut, gh, curl polling) while you work on something else\n- Run experiments, benchmarks, or training scripts in parallel\n- Tail a log or poll an API endpoint\n- Fire off a slow curl/fetch and check the result later\n- Run any script or command you don't need to wait on inline

## Events emitted

- "monitor:output" — { monitorId, line, timestamp } for each output line\n- "monitor:done" — { monitorId, exitCode, outputLines } on clean exit\n- "monitor:error" — { monitorId, error } on failure

## onDone — auto-notify on completion

Pass onDone with a prompt and the monitor auto-creates a one-shot loop that fires when the process exits. The system reminder includes the exit code and output line count.\n\nExample: MonitorCreate command="python train.py" onDone="Check training results and report best loss"\nExample: MonitorCreate command="hut builds show 1769753" onDone="Analyze the build result and report status"`,
    promptGuidelines: [
      "Default to MonitorCreate for any long-running or background command — releases the agent to keep working on other tasks in parallel.",
      "When the user asks to monitor CI builds, watch a build, check a remote job, or run an experiment, use MonitorCreate instead of inline bash/curl/wait.",
      "Use onDone to auto-notify when a background command finishes — the agent will pick up the results automatically.",
    ],
    parameters: Type.Object({
      command: Type.String({ description: "Shell command to run in background" }),
      description: Type.Optional(Type.String({ description: "Human-readable description" })),
      timeout: Type.Optional(Type.Number({ description: "Auto-stop after N ms (default: 300000, 0 = no timeout)", default: 300000 })),
      onDone: Type.Optional(Type.String({ description: "Prompt to run when the monitor completes. Auto-creates a one-shot completion loop — no need for a separate LoopCreate." })),
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
        triggerSystem.add(doneLoop);
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
    description: `List all monitors with their status, command, and output line count.`,
    parameters: Type.Object({}),

    execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const monitors = monitorManager.list();
      if (monitors.length === 0) return Promise.resolve(textResult("No monitors running."));

      const lines: string[] = [];
      for (const m of monitors) {
        const icon = m.status === "running" ? "◉" : m.status === "completed" ? "✓" : "✗";
        const age = Date.now() - m.startedAt;
        const ageStr = formatRemaining(age);
        lines.push(`${icon} #${m.id} [${m.status}] ${m.command.slice(0, 50)} — ${m.outputLines} lines (${ageStr})`);
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
        } catch (err: any) {
          ui.notify(err.message, "error");
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

  async function scheduleLoop(ui: any, prompt?: string) {
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
    } catch (err: any) {
      ui.notify(err.message, "error");
    }
  }

  async function eventLoop(ui: any, prompt?: string) {
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

  async function viewLoops(ui: any) {
    const loops = store.list();
    if (loops.length === 0) {
      await ui.select("No active loops", ["← Back"]);
      return;
    }

    const choices = loops.map((l: LoopEntry) => {
      const icon = l.status === "active" ? "⟳" : l.status === "paused" ? "⏸" : "✗";
      const triggerDesc = l.trigger.type === "cron" ? `cron: ${l.trigger.schedule}` : l.trigger.type === "event" ? `event: ${l.trigger.source}` : `hybrid: ${l.trigger.cron}`;
      return `${icon} #${l.id} [${l.status}] ${l.prompt.slice(0, 50)} (${triggerDesc})`;
    });
    choices.push("← Back");

    const selected = await ui.select("Active Loops", choices);
    if (!selected || selected === "← Back") return;

    const match = selected.match(/#(\d+)/);
    if (match) {
      const entry = store.get(match[1]);
      if (entry) {
        const actions = ["✗ Delete"];
        if (entry.status === "active") actions.unshift("⏸ Pause");
        else if (entry.status === "paused") actions.unshift("▶ Resume");
        actions.push("← Back");

        const action = await ui.select(
          `#${entry.id}: ${entry.prompt}\nTrigger: ${JSON.stringify(entry.trigger)}`,
          actions,
        );

        if (action === "✗ Delete") {
          triggerSystem.remove(entry.id);
          store.delete(entry.id);
          widget.update();
          ui.notify(`Loop #${entry.id} deleted`, "info");
        } else if (action === "⏸ Pause") {
          store.update(entry.id, { status: "paused" });
          triggerSystem.remove(entry.id);
          widget.update();
          ui.notify(`Loop #${entry.id} paused`, "info");
        } else if (action === "▶ Resume") {
          store.update(entry.id, { status: "active" });
          triggerSystem.add(entry);
          widget.update();
          ui.notify(`Loop #${entry.id} resumed`, "info");
        }
      }
    }

    return viewLoops(ui);
  }

  async function settings(ui: any) {
    const loops = store.list();
    const active = loops.filter(l => l.status === "active").length;
    ui.notify(`${active}/${loops.length} active loops (max 25)`, "info");
  }
}
