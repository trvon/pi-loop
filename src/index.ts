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
import { resolveDefaultLoopExpiryMs } from "./loop-expiry.js";
import { atMaxFires } from "./loop-reducer.js";
import { MonitorManager } from "./monitor-manager.js";
import { rpcCall, rpcProbe } from "./rpc/cross-extension-rpc.js";
import { buildLoopExpiredPayload } from "./runtime/loop-events.js";
import { createMonitorOnDoneRuntime } from "./runtime/monitor-ondone-runtime.js";
import {
  createNotificationRuntime,
  type LoopFireEvent,
} from "./runtime/notification-runtime.js";
import { resolveLoopStorePath, resolveTaskStorePath } from "./runtime/scope.js";
import { registerSessionRuntimeHooks } from "./runtime/session-runtime.js";
import { isStaleExtensionContextError } from "./runtime/stale-context.js";
import { createSubagentOrchestrationRuntime, type SubagentOrchestrationRuntime } from "./runtime/subagent-orchestration-runtime.js";
import { createTaskBacklogRuntime } from "./runtime/task-backlog-runtime.js";
import { createTaskProviderRuntime, type TaskProviderRuntime } from "./runtime/task-provider-runtime.js";
import { createMonitorWorkflowAdmissionProvider } from "./runtime/workflow-admission-providers.js";
import { CronScheduler } from "./scheduler.js";
import { LoopStore } from "./store.js";
import { registerLoopTools } from "./tools/loop-tools.js";
import { registerMonitorTools } from "./tools/monitor-tools.js";
import { registerSubagentOrchestrationTools } from "./tools/subagent-orchestration-tools.js";
import { registerWorkflowTools } from "./tools/workflow-tools.js";
import { TriggerSystem } from "./trigger-system.js";
import type { LoopEntry, LoopExpiryDisposition, LoopExpiryReason, LoopExpirySource, LoopFireOrigin, MonitorEntry, Trigger } from "./types.js";
import { LoopWidget } from "./ui/widget.js";
import { atWorkflowStateFireLimit, getActiveWorkflowStateLoop, isTerminalWorkflowRun } from "./workflow-reducer.js";

const DEBUG = !!process.env.PI_LOOP_DEBUG;
function debug(...args: unknown[]) {
  if (DEBUG) console.error("[pi-loop]", ...args);
}

export default function (pi: ExtensionAPI) {
  const runtimeId = randomUUID();
  const runtimeProbeEvent = `pi-loop:runtime-probe:${runtimeId}`;
  const piLoopEnv = process.env.PI_LOOP;
  const piLoopScope = process.env.PI_LOOP_SCOPE as "memory" | "session" | "project" | undefined;
  let loopScope: "memory" | "session" | "project" = piLoopScope ?? "session";
  let sessionGeneration = 0;
  let _latestCtx: ExtensionContext | undefined;
  let _sessionId: string | undefined;
  let orchestrationRuntime: SubagentOrchestrationRuntime | undefined;

  const getScopeOptions = () => ({ piLoopEnv, loopScope });
  const defaultLoopExpiryMs = resolveDefaultLoopExpiryMs(process.env.PI_LOOP_EXPIRES_IN);

  let store = new LoopStore(resolveLoopStorePath(getScopeOptions()), defaultLoopExpiryMs);
  const memoryLoopStores = new Map<string, LoopStore>();
  const monitorManager = new MonitorManager(pi);
  const monitorWorkflowAdmissionProvider = createMonitorWorkflowAdmissionProvider((id) => monitorManager.get(id));
  let scheduler: CronScheduler;
  let triggerSystem: TriggerSystem;
  const widget = new LoopWidget(store, monitorManager);
  // Repaint the status bar when a monitor finishes/prunes on its own (no tool
  // call), so stale monitors don't linger in the count between turns.
  monitorManager.setOnChange(() => widget.update());

  function createScheduler(loopStore: LoopStore): CronScheduler {
    return new CronScheduler(
      loopStore,
      (entry, origin) => onLoopFire(entry, undefined, origin),
      (entry, disposition) => emitLoopExpired(entry, disposition, "scheduler", "expires_at"),
      isCurrentExtensionContext,
    );
  }

  scheduler = createScheduler(store);
  triggerSystem = new TriggerSystem(pi, scheduler, store, (entry, origin) => onLoopFire(entry, undefined, origin));

  let taskProvider: TaskProviderRuntime | undefined;
  const activeTaskBacklogWakes = new Set<string>();
  const hasPendingTasks = () => taskProvider?.hasPendingTasks() ?? Promise.resolve(-1);
  const cleanDoneTasks = () => taskProvider?.cleanDoneTasks() ?? Promise.resolve();

  const notificationRuntime = createNotificationRuntime({
    pi,
    hasPendingTasks: () => hasPendingTasks(),
    cleanDoneTasks: () => cleanDoneTasks(),
    getHasPendingMessages: () => _latestCtx?.hasPendingMessages() ?? false,
    getLoop: (id) => store.get(id),
    onLoopNotificationDelivered: ({ loopId, orchestrationWakeSequence }) => {
      if (orchestrationWakeSequence !== undefined) orchestrationRuntime?.acknowledgeWake(loopId, orchestrationWakeSequence);
    },
    debug,
  });

  const monitorOnDoneRuntime = createMonitorOnDoneRuntime({
    monitorManager,
    getLoop: (id) => store.get(id),
    deleteLoop: (id) => {
      store.delete(id);
    },
    expireLoop: (id, now) => {
      const record = store.expireEntry(id, now);
      if (!record) return false;
      emitLoopExpired(record.entry, record.disposition, "monitor", record.reason);
      return true;
    },
    onLoopFire: (entry) => onLoopFire(entry, undefined, "monitor", entry.prompt),
    isContextCurrent: isCurrentExtensionContext,
    settleWorkflowMonitorWait: (id, expected, now) => {
      const settlement = store.settleWorkflowMonitorWait(id, expected, now);
      if (settlement.kind === "expired") {
        emitLoopExpired(settlement.entry, settlement.disposition, "monitor", settlement.reason);
      }
      return settlement;
    },
    rearmWorkflow: (entry) => {
      triggerSystem.add(entry);
    },
    wakeWorkflow: (entry, monitor) => {
      onLoopFire(entry, monitor);
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
    onReady: async (detectionGeneration) => {
      const generation = detectionGeneration ?? sessionGeneration;
      await adoptTaskBacklogLoops(undefined, () => generation === sessionGeneration);
    },
    getSessionGeneration: () => sessionGeneration,
    updateWidget: () => {
      widget.update();
    },
    isStaleExtensionContextError,
    debug,
  });
  widget.setTaskSummaryProvider(() => taskProvider?.summary() ?? { count: 0 });

  // ── Loop fire handler ──

  function isCurrentExtensionContext(): boolean {
    try {
      pi.events.emit(runtimeProbeEvent, { runtimeId, sessionGeneration });
      return true;
    } catch (error) {
      if (!isStaleExtensionContextError(error)) throw error;
      debug("extension context went stale, dropping runtime callback");
      return false;
    }
  }

  function emitLoopExpired(
    entry: LoopEntry,
    disposition: LoopExpiryDisposition,
    source: LoopExpirySource,
    reason: LoopExpiryReason,
    generation = sessionGeneration,
  ): void {
    if (generation !== sessionGeneration || !isCurrentExtensionContext()) return;
    triggerSystem.remove(entry.id);
    const payload = buildLoopExpiredPayload(entry, disposition, source, reason, Date.now());
    try {
      pi.events.emit("loops:expired", payload);
    } catch (error) {
      debug(`loops:expired #${entry.id} — event listener failed`, error);
    }
    void notificationRuntime.queueOrDeliverLoopExpired({ ...payload, sessionGeneration: generation })
      .catch((error) => debug(`loops:expired #${entry.id} — notification failed`, error));
  }

  function emitLoopFire(entry: LoopEntry, monitor?: MonitorEntry, orchestrationWakeSequence?: number): void {
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
      controllerStatus: entry.status,
      orchestration: entry.orchestration,
      orchestrationWakeSequence,
      fireLimitReached: atMaxFires(entry),
      workflowStateFireLimitReached: !!entry.workflow && atWorkflowStateFireLimit(entry.workflow),
      sessionGeneration,
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

  function onLoopFire(
    entry: LoopEntry,
    monitor?: MonitorEntry,
    origin: LoopFireOrigin = monitor ? "monitor" : "dynamic",
    promptOverride?: string,
  ): void {
    if (!isCurrentExtensionContext()) return;
    debug(`loop:fire #${entry.id}`, { prompt: entry.prompt.slice(0, 50) });
    const current = store.get(entry.id);
    if (current?.status !== "active" || isTerminalWorkflowRun(current?.workflow)) {
      triggerSystem.remove(entry.id);
      return;
    }
    if (current.workflow?.waitingMonitor) {
      debug(`workflow #${entry.id} — waiting on monitor; suppressing cadence wake`);
      return;
    }

    const isTaskBacklog = taskBacklogRuntime.isTaskBacklogLoop(current);
    if (isTaskBacklog && activeTaskBacklogWakes.has(entry.id)) {
      debug(`task backlog loop #${entry.id} — wake already active, adopting event into current wake`);
      return;
    }

    if (atMaxFires(current)) {
      debug(`loop #${current.id} — reached maxFires ${current.maxFires}, retiring`);
      triggerSystem.remove(current.id);
      if (current.workflow || current.taskBacklog) store.pause(current.id, "controller_limit", "loop fire cap reached");
      else store.delete(current.id);
      widget.update();
      return;
    }
    if (isTaskBacklog) activeTaskBacklogWakes.add(current.id);
    const fired = store.fire(current.id, origin);
    if (!fired) return;

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
    const firedEntry = updatedEntry;

    if (atMaxFires(firedEntry)) {
      triggerSystem.remove(firedEntry.id);
      if (firedEntry.workflow || firedEntry.taskBacklog) store.pause(firedEntry.id, "controller_limit", "loop fire cap reached");
      else store.delete(firedEntry.id);
      widget.update();
    }

    if (firedEntry.workflow && atWorkflowStateFireLimit(firedEntry.workflow)) {
      triggerSystem.remove(firedEntry.id);
      store.pause(firedEntry.id, "controller_limit", "workflow state fire cap reached");
      widget.update();
    }

    if (current.autoTask) {
      taskProvider?.autoCreateTask(current).then((taskId) => {
        if (taskId) debug(`loop #${current.id} → task #${taskId}`);
      });
    }

    const authoritativeEntry = store.get(firedEntry.id) ?? firedEntry;
    emitLoopFire({
      ...authoritativeEntry,
      prompt: promptOverride ?? authoritativeEntry.prompt,
    }, monitor);
  }

  // ── Session lifecycle ──

  orchestrationRuntime = createSubagentOrchestrationRuntime({
    events: pi.events,
    getStore: () => store,
    getScope: () => loopScope,
    getPiLoopEnv: () => piLoopEnv,
    getActor: () => _sessionId ? { sessionId: _sessionId, runtimeId, generation: sessionGeneration } : undefined,
    getGeneration: () => sessionGeneration,
    rpcCall: (channel, params, timeoutMs) => rpcCall(pi.events, channel, params, timeoutMs),
    emitWake: (entry, wake) => emitLoopFire(entry, undefined, wake.sequence),
    onExpired: (entry, disposition) => emitLoopExpired(entry, disposition, "scheduler", "expires_at"),
    updateWidget: () => widget.update(),
    isContextCurrent: isCurrentExtensionContext,
    debug,
  });

  registerSessionRuntimeHooks({
    pi,
    getLoopScope: () => loopScope,
    getPiLoopEnv: () => piLoopEnv,
    getSessionGeneration: () => sessionGeneration,
    advanceSessionGeneration: () => ++sessionGeneration,
    recreateSessionStore: (sessionId: string) => {
      const path = resolveLoopStorePath(getScopeOptions(), sessionId);
      if (path) store = new LoopStore(path, defaultLoopExpiryMs);
      else {
        store = memoryLoopStores.get(sessionId) ?? new LoopStore(undefined, defaultLoopExpiryMs);
        memoryLoopStores.set(sessionId, store);
      }
      widget.setStore(store);
      scheduler = createScheduler(store);
      triggerSystem = new TriggerSystem(pi, scheduler, store, (entry, origin) => onLoopFire(entry, undefined, origin));
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
    recoverOrchestrations: () => orchestrationRuntime!.recover(),
    pumpOrchestrations: () => orchestrationRuntime!.pump(),
    shutdownOrchestrations: () => orchestrationRuntime!.shutdown(),
    shutdownMonitors: () => monitorManager.shutdown(),
    hasPendingTasks,
    cleanDoneTasks,
    isContextCurrent: isCurrentExtensionContext,
    emitLoopExpired: (entry, disposition, reason, generation) => {
      emitLoopExpired(entry, disposition, "session_recovery", reason, generation);
    },
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
    const sourceGeneration = sessionGeneration;
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
      sessionGeneration: sourceGeneration,
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
    cancelOrchestration: (id, action) => orchestrationRuntime!.cancel(id, action),
  });

  registerSubagentOrchestrationTools({
    pi,
    getStore: () => store,
    getScope: () => loopScope,
    getPiLoopEnv: () => piLoopEnv,
    getActor: () => _sessionId ? { sessionId: _sessionId, runtimeId, generation: sessionGeneration } : undefined,
    probeSubagents: () => rpcProbe(pi.events, "subagents:rpc:ping", 1_000),
    updateWidget: () => widget.update(),
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
    getActor: () => _sessionId ? { sessionId: _sessionId, runtimeId } : undefined,
    getAdmissionContextDigest: () => resolveLoopStorePath(getScopeOptions(), _sessionId)
      ?? `memory:${process.cwd()}:${_sessionId ?? "unbound"}`,
    getAdmissionProviders: () => [monitorWorkflowAdmissionProvider],
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
    cancelOrchestration: (id, action) => orchestrationRuntime!.cancel(id, action),
  });

}
