/**
 * @trevonistrevon/pi-loop — A pi extension providing cron/event-based agent re-wake loops and background process monitoring.
 *
 * Tools:
 *   LoopCreate    — Create a scheduled or event-triggered re-wake loop
 *   LoopList      — List all active loops with status and next-fire times
 *   LoopUpdate    — Continue, pause, or complete a dynamic goal loop
 *   LoopDelete    — Delete or pause a loop by ID
 *   MonitorCreate — Start a background command that streams output via pi events
 *   MonitorList   — List running monitors
 *   MonitorStop   — Stop a running monitor
 *
 * Commands:
 *   /loop    — Schedule or manage re-wake loops, including /loop <goal>
 *   /tasks   — View or manage native fallback tasks when pi-tasks is absent
 */

import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerLoopCommand } from "./commands/loop-command.js";
import { atMaxFires } from "./loop-reducer.js";
import { MonitorManager } from "./monitor-manager.js";
import { createMonitorOnDoneRuntime } from "./runtime/monitor-ondone-runtime.js";
import {
  createNotificationRuntime,
  type LoopFireEvent,
} from "./runtime/notification-runtime.js";
import { resolveLoopStorePath, resolveTaskStorePath } from "./runtime/scope.js";
import { registerSessionRuntimeHooks } from "./runtime/session-runtime.js";
import { isStaleExtensionContextError } from "./runtime/stale-context.js";
import { createTaskBacklogRuntime } from "./runtime/task-backlog-runtime.js";
import { createTaskProviderRuntime, type TaskProviderRuntime } from "./runtime/task-provider-runtime.js";
import { CronScheduler } from "./scheduler.js";
import { LoopStore } from "./store.js";
import { registerLoopTools } from "./tools/loop-tools.js";
import { registerMonitorTools } from "./tools/monitor-tools.js";
import { registerWorkflowTools } from "./tools/workflow-tools.js";
import { TriggerSystem } from "./trigger-system.js";
import type { LoopEntry, MonitorEntry, Trigger } from "./types.js";
import { LoopWidget } from "./ui/widget.js";
import { atWorkflowStateFireLimit, getActiveWorkflowStateLoop } from "./workflow-reducer.js";

const DEBUG = !!process.env.PI_LOOP_DEBUG;
function debug(...args: unknown[]) {
  if (DEBUG) console.error("[pi-loop]", ...args);
}

export default function (pi: ExtensionAPI) {
  const runtimeId = randomUUID();
  const piLoopEnv = process.env.PI_LOOP;
  const piLoopScope = process.env.PI_LOOP_SCOPE as "memory" | "session" | "project" | undefined;
  let loopScope: "memory" | "session" | "project" = piLoopScope ?? "session";

  const getScopeOptions = () => ({ piLoopEnv, loopScope });

  let store = new LoopStore(resolveLoopStorePath(getScopeOptions()));
  const memoryLoopStores = new Map<string, LoopStore>();
  const monitorManager = new MonitorManager(pi);
  let scheduler: CronScheduler;
  let triggerSystem: TriggerSystem;
  const widget = new LoopWidget(store, monitorManager);
  // Repaint the status bar when a monitor finishes/prunes on its own (no tool
  // call), so stale monitors don't linger in the count between turns.
  monitorManager.setOnChange(() => widget.update());

  scheduler = new CronScheduler(store, onLoopFire);
  triggerSystem = new TriggerSystem(pi, scheduler, store, onLoopFire);

  let taskProvider: TaskProviderRuntime | undefined;
  const activeTaskBacklogWakes = new Set<string>();
  const hasPendingTasks = () => taskProvider?.hasPendingTasks() ?? Promise.resolve(-1);
  const cleanDoneTasks = () => taskProvider?.cleanDoneTasks() ?? Promise.resolve();

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
    completeWorkflowMonitorWait: (id, expected) => store.completeWorkflowMonitorWait(id, expected),
    rearmWorkflow: (entry) => {
      triggerSystem.add(entry);
    },
    wakeWorkflow: (entry, monitor) => {
      emitLoopFire(entry, monitor);
    },
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
    if (!entry.recurring || !entry.taskBacklog) return false;
    if (!triggerHasEventSource(entry.trigger, "tasks:created")) return false;

    const pending = await hasPendingTasks();
    if (pending <= 0) return false;

    debug(`loop #${entry.id} — bootstrapping existing pending tasks (${pending})`);
    onLoopFire(entry);
    return true;
  }

  const taskBacklogRuntime = createTaskBacklogRuntime({
    getLoops: () => store.list(),
    deleteLoop: (id) => {
      store.delete(id);
    },
    updateLoopWorker: (id, prompt) => store.updateMetadata(id, { prompt, taskBacklog: true }).entry,
    recordDeletionTombstone: (id, tombstone) => {
      store.recordDeletionTombstone(id, tombstone);
    },
    removeTrigger: (id) => {
      triggerSystem.remove(id);
    },
    updateWidget: () => {
      widget.update();
    },
    hasPendingTasks: () => hasPendingTasks(),
    adoptLoop: (entry) => {
      onLoopFire(entry);
    },
    triggerHasEventSource,
    emitLoopAutodeleted: (payload) => {
      pi.events.emit("loops:autodeleted", payload);
    },
    emitTaskBacklogEmpty: (payload) => {
      pi.events.emit("tasks:backlog_empty", payload);
    },
    debug,
  });

  const flushPendingNotifications = notificationRuntime.flushPendingNotifications;
  const queueOrDeliverNotification = notificationRuntime.queueOrDeliverNotification;
  const queueOrDeliverMonitorStarted = notificationRuntime.queueOrDeliverMonitorStarted;
  const discardMonitorStarted = notificationRuntime.discardMonitorStarted;
  const migrateTaskBacklogLoops = taskBacklogRuntime.migrateAutoTaskWorkerPrompts;
  const cleanupTaskBacklogLoops = taskBacklogRuntime.cleanupTaskBacklogLoops;
  const adoptTaskBacklogLoops = taskBacklogRuntime.adoptTaskBacklogLoops;
  const evaluateTaskBacklog = taskBacklogRuntime.evaluateTaskBacklog;

  taskProvider = createTaskProviderRuntime({
    pi,
    runtimeId,
    resolveStorePath: () => resolveTaskStorePath(getScopeOptions(), _sessionId),
    getSessionId: () => _sessionId,
    evaluateTaskBacklog,
    onReady: async () => {
      await adoptTaskBacklogLoops();
    },
    updateWidget: () => {
      widget.update();
    },
    isStaleExtensionContextError,
    debug,
  });
  widget.setTaskSummaryProvider(() => taskProvider?.summary() ?? { count: 0 });

  // ── Loop fire handler ──

  function emitLoopFire(entry: LoopEntry, monitor?: MonitorEntry): void {
    pi.events.emit("loop:fire", {
      loopId: entry.id,
      prompt: entry.prompt,
      trigger: entry.trigger,
      timestamp: Date.now(),
      readOnly: entry.readOnly,
      recurring: entry.recurring,
      persistent: entry.recurring,
      autoTask: entry.autoTask,
      taskBacklog: entry.taskBacklog,
      dynamic: entry.dynamic,
      workflow: entry.workflow,
      monitorOutcome: monitor
        ? {
            monitorId: monitor.id,
            status: monitor.status,
            exitCode: monitor.exitCode,
            stopReason: monitor.stopReason,
            outputLines: monitor.outputLines,
          }
        : undefined,
    });
  }

  function onLoopFire(entry: LoopEntry): void {
    debug(`loop:fire #${entry.id}`, { prompt: entry.prompt.slice(0, 50) });
    if (store.get(entry.id)?.workflow?.waitingMonitor) {
      debug(`workflow #${entry.id} — waiting on monitor; suppressing cadence wake`);
      return;
    }

    const isTaskBacklog = taskBacklogRuntime.isTaskBacklogLoop(entry);
    if (isTaskBacklog && activeTaskBacklogWakes.has(entry.id)) {
      debug(`task backlog loop #${entry.id} — wake already active, adopting event into current wake`);
      return;
    }

    if (atMaxFires(entry)) {
      debug(`loop #${entry.id} — reached maxFires ${entry.maxFires}, retiring`);
      triggerSystem.remove(entry.id);
      if (entry.workflow || entry.taskBacklog) store.pause(entry.id);
      else store.delete(entry.id);
      widget.update();
      return;
    }
    if (isTaskBacklog) activeTaskBacklogWakes.add(entry.id);
    const fired = store.fire(entry.id) ?? entry;

    const firedAt = Date.now();
    const stateLoop = fired.workflow && getActiveWorkflowStateLoop(fired.workflow);
    const updatedEntry = fired.trigger.type === "dynamic" && !stateLoop
      ? store.updateDynamic(fired.id, {
          dynamic: {
            awaitingUpdate: true,
            nextWakeAt: undefined,
            lastUpdatedAt: firedAt,
          },
        }) ?? fired
      : fired;
    const firedEntry = { ...updatedEntry, prompt: entry.prompt };

    if (firedEntry.workflow && atWorkflowStateFireLimit(firedEntry.workflow)) {
      triggerSystem.remove(firedEntry.id);
      store.pause(firedEntry.id);
      widget.update();
    }

    if (entry.autoTask) {
      taskProvider?.autoCreateTask(entry).then((taskId) => {
        if (taskId) debug(`loop #${entry.id} → task #${taskId}`);
      });
    }

    emitLoopFire(firedEntry);
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
      if (path) store = new LoopStore(path);
      else {
        store = memoryLoopStores.get(sessionId) ?? new LoopStore();
        memoryLoopStores.set(sessionId, store);
      }
      widget.setStore(store);
      scheduler = new CronScheduler(store, onLoopFire);
      triggerSystem = new TriggerSystem(pi, scheduler, store, onLoopFire);
    },
    clearAllLoops: () => {
      store.clearAll({ preserveWorkflows: true });
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
    migrateTaskBacklogLoops,
    cleanupTaskBacklogLoops,
    adoptTaskBacklogLoops,
    releaseTaskBacklogWakes: () => {
      activeTaskBacklogWakes.clear();
    },
    clearWorkflowMonitorWaits: () => {
      store.clearWorkflowMonitorWaits();
    },
    shutdownMonitors: () => monitorManager.shutdown(),
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

  pi.events.on("monitor:started", async (event: unknown) => {
    const data = event as {
      monitorId?: string;
      command?: string;
      description?: string;
      timestamp?: number;
    };
    if (!data.monitorId || !data.command) return;
    await queueOrDeliverMonitorStarted({
      monitorId: data.monitorId,
      command: data.command,
      description: data.description,
      timestamp: data.timestamp ?? Date.now(),
    });
  });

  pi.events.on("monitor:finished", (event: unknown) => {
    const data = event as { monitorId?: string };
    if (data.monitorId) discardMonitorStarted(data.monitorId);
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
    isTaskSystemReady: () => taskProvider?.isReady() ?? false,
    onDynamicLoopActivated: (entry) => {
      onLoopFire(entry);
    },
    closeWorkflowTask: (taskId, claimId) => taskProvider?.closeWorkflowTask(taskId, claimId) ?? Promise.resolve(false),
  });

  registerWorkflowTools({
    pi,
    getStore: () => store,
    getTriggerSystem: () => triggerSystem,
    updateWidget: () => {
      widget.update();
    },
    onDynamicLoopActivated: (entry) => {
      onLoopFire(entry);
    },
    createWorkflowTask: (entry) => taskProvider?.createWorkflowTask(entry) ?? Promise.resolve(undefined),
    completeWorkflowTask: (taskId, claimId) => taskProvider?.completeWorkflowTask(taskId, claimId) ?? Promise.resolve(false),
    closeWorkflowTask: (taskId, claimId) => taskProvider?.closeWorkflowTask(taskId, claimId) ?? Promise.resolve(false),
  });

  function handleMonitorDoneLoop(doneLoop: LoopEntry, monitorId: string): void {
    monitorOnDoneRuntime.register(doneLoop, monitorId);
  }

  function handleWorkflowMonitorWait(entry: LoopEntry): void {
    monitorOnDoneRuntime.registerWorkflowWait(entry);
  }

  registerMonitorTools({
    pi,
    getStore: () => store,
    getMonitorManager: () => monitorManager,
    getTriggerSystem: () => triggerSystem,
    updateWidget: () => {
      widget.update();
    },
    handleMonitorDoneLoop,
    handleWorkflowMonitorWait,
  });

  registerLoopCommand({
    pi,
    getStore: () => store,
    getTriggerSystem: () => triggerSystem,
    updateWidget: () => {
      widget.update();
    },
    maybeBootstrapTaskLoop,
    onDynamicLoopActivated: (entry) => {
      onLoopFire(entry);
    },
  });

}
