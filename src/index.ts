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
 *   /loop    — Schedule or manage re-wake loops: /loop [interval] [prompt]
 *   /tasks   — View or manage native fallback tasks when pi-tasks is absent
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerLoopCommand } from "./commands/loop-command.js";
import { registerTasksCommand } from "./commands/tasks-command.js";
import { atMaxFires } from "./loop-reducer.js";
import { MonitorManager } from "./monitor-manager.js";
import { createMonitorOnDoneRuntime } from "./runtime/monitor-ondone-runtime.js";
import {
  createNotificationRuntime,
  type LoopFireEvent,
} from "./runtime/notification-runtime.js";
import { resolveLoopStorePath, resolveTaskStorePath } from "./runtime/scope.js";
import { registerSessionRuntimeHooks } from "./runtime/session-runtime.js";
import { createTaskBacklogRuntime } from "./runtime/task-backlog-runtime.js";
import { createTaskRuntimeBridge } from "./runtime/task-rpc.js";
import { CronScheduler } from "./scheduler.js";
import { LoopStore } from "./store.js";
import { TaskStore } from "./task-store.js";
import { registerLoopTools } from "./tools/loop-tools.js";
import { registerMonitorTools } from "./tools/monitor-tools.js";
import { registerNativeTaskTools } from "./tools/native-task-tools.js";
import { TriggerSystem } from "./trigger-system.js";
import type { LoopEntry, Trigger } from "./types.js";
import { LoopWidget } from "./ui/widget.js";

const DEBUG = !!process.env.PI_LOOP_DEBUG;
function debug(...args: unknown[]) {
  if (DEBUG) console.error("[pi-loop]", ...args);
}

function isStaleExtensionContextError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("extension ctx is stale");
}

export default function (pi: ExtensionAPI) {
  const piLoopEnv = process.env.PI_LOOP;
  const piLoopScope = process.env.PI_LOOP_SCOPE as "memory" | "session" | "project" | undefined;
  let loopScope: "memory" | "session" | "project" = piLoopScope ?? "session";

  const getScopeOptions = () => ({ piLoopEnv, loopScope });

  let store = new LoopStore(resolveLoopStorePath(getScopeOptions()));
  const monitorManager = new MonitorManager(pi);
  let scheduler: CronScheduler;
  let triggerSystem: TriggerSystem;
  const widget = new LoopWidget(store, monitorManager);
  // Repaint the status bar when a monitor finishes/prunes on its own (no tool
  // call), so stale monitors don't linger in the count between turns.
  monitorManager.setOnChange(() => widget.update());
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

  const taskRuntime = createTaskRuntimeBridge({
    pi,
    isTasksAvailable: () => tasksAvailable,
    setTasksAvailable: (available) => {
      if (available) tasksAvailable = true;
    },
    getNativeTaskStore: () => nativeTaskStore,
    onNativeTaskCreated: () => {
      widget.update();
    },
    onNativeTasksPruned: async (taskStore) => {
      widget.update();
      await evaluateTaskBacklog(taskStore, taskStore.pendingCount());
    },
    debug,
  });

  taskRuntime.checkTasksVersion();
  pi.events.on("tasks:ready", () => taskRuntime.checkTasksVersion());

  const autoCreateTask = taskRuntime.autoCreateTask;
  const hasPendingTasks = taskRuntime.hasPendingTasks;
  const cleanDoneTasks = taskRuntime.cleanDoneTasks;

  const notificationRuntime = createNotificationRuntime({
    pi,
    hasPendingTasks: () => hasPendingTasks(),
    cleanDoneTasks: () => cleanDoneTasks(),
    getHasPendingMessages: () => _latestCtx?.hasPendingMessages() ?? false,
    debug,
  });

  const monitorOnDoneRuntime = createMonitorOnDoneRuntime({
    monitorManager,
    getLoop: (id) => store.get(id),
    deleteLoop: (id) => {
      store.delete(id);
    },
    onLoopFire,
    debug,
  });


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

  const taskBacklogRuntime = createTaskBacklogRuntime({
    getLoops: () => store.list(),
    createLoop: (trigger, prompt, options) => store.create(trigger, prompt, options),
    deleteLoop: (id) => {
      store.delete(id);
    },
    addTrigger: (entry) => {
      triggerSystem.add(entry);
    },
    removeTrigger: (id) => {
      triggerSystem.remove(id);
    },
    updateWidget: () => {
      widget.update();
    },
    hasPendingTasks: () => hasPendingTasks(),
    bootstrapTaskLoop: (entry) => maybeBootstrapTaskLoop(entry),
    triggerHasEventSource,
    debug,
  });

  const flushPendingNotifications = notificationRuntime.flushPendingNotifications;
  const queueOrDeliverNotification = notificationRuntime.queueOrDeliverNotification;
  const cleanupTaskBacklogLoops = taskBacklogRuntime.cleanupTaskBacklogLoops;
  const evaluateTaskBacklog = taskBacklogRuntime.evaluateTaskBacklog;

  // ── Loop fire handler ──

  function onLoopFire(entry: LoopEntry): void {
    debug(`loop:fire #${entry.id}`, { prompt: entry.prompt.slice(0, 50) });

    if (atMaxFires(entry)) {
      debug(`loop #${entry.id} — reached maxFires ${entry.maxFires}, expiring`);
      store.delete(entry.id);
      return;
    }
    store.fire(entry.id);

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

  let _latestCtx: ExtensionContext | undefined;
  let _sessionId: string | undefined;

  registerSessionRuntimeHooks({
    pi,
    getLoopScope: () => loopScope,
    getPiLoopEnv: () => piLoopEnv,
    recreateSessionStore: (sessionId: string) => {
      const path = resolveLoopStorePath(getScopeOptions(), sessionId);
      store = new LoopStore(path);
      widget.setStore(store);
      scheduler = new CronScheduler(store, onLoopFire);
      triggerSystem = new TriggerSystem(pi, scheduler, store, onLoopFire);
    },
    clearAllLoops: () => {
      store.clearAll();
    },
    getStore: () => store,
    getScheduler: () => scheduler,
    getTriggerSystem: () => triggerSystem,
    setLatestCtx: (ctx) => {
      _latestCtx = ctx;
    },
    setSessionId: (sessionId) => {
      _sessionId = sessionId;
    },
    widget,
    notificationRuntime,
    flushPendingNotifications,
    cleanupTaskBacklogLoops,
    hasPendingTasks,
    cleanDoneTasks,
  });

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

  registerLoopTools({
    pi,
    getStore: () => store,
    getTriggerSystem: () => triggerSystem,
    getScheduler: () => scheduler,
    getMonitorManager: () => monitorManager,
    updateWidget: () => {
      widget.update();
    },
    maybeBootstrapTaskLoop,
    isTaskSystemReady: () => tasksAvailable || nativeTasksRegistered,
  });

  function handleMonitorDoneLoop(doneLoop: LoopEntry, monitorId: string): void {
    monitorOnDoneRuntime.register(doneLoop, monitorId);
  }

  registerMonitorTools({
    pi,
    getStore: () => store,
    getMonitorManager: () => monitorManager,
    updateWidget: () => {
      widget.update();
    },
    handleMonitorDoneLoop,
  });

  registerLoopCommand({
    pi,
    getStore: () => store,
    getTriggerSystem: () => triggerSystem,
    updateWidget: () => {
      widget.update();
    },
  });

  // ── Native task tools (only when pi-tasks is absent) ──

  const nativeTaskFallbackTimer = setTimeout(() => {
    if (tasksAvailable || nativeTasksRegistered) return;
    const taskStore = new TaskStore(resolveTaskStorePath(getScopeOptions(), _sessionId));

    try {
      registerTasksCommand({
        pi,
        getNativeTaskStore: () => nativeTaskStore,
        evaluateTaskBacklog,
        updateWidget: () => {
          widget.update();
        },
      });

      registerNativeTaskTools({
        pi,
        taskStore,
        evaluateTaskBacklog,
        updateWidget: () => {
          widget.update();
        },
      });
    } catch (error) {
      if (isStaleExtensionContextError(error)) {
        debug("native task fallback skipped: extension context went stale");
        return;
      }
      throw error;
    }

    nativeTaskStore = taskStore;
    nativeTasksRegistered = true;
    debug("native task tools registered (pi-tasks not detected)");
  }, 6000);

  pi.on("session_shutdown", () => {
    clearTimeout(nativeTaskFallbackTimer);
  });
}
