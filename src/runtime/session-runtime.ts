import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { LoopStore } from "../store.js";
import type { LoopEntry, LoopExpiryDisposition, LoopExpiryReason } from "../types.js";
import type { NotificationRuntime } from "./notification-runtime.js";
import type { LoopScope } from "./scope.js";

export interface SessionSwitchEvent {
  reason?: string;
}

// Wall-clock cadence for the idle heartbeat that pumps the scheduler. Cron is
// minute-granular, so 30s gives sub-minute wake latency while idle.
const HEARTBEAT_MS = 30_000;

export interface SessionRuntimeOptions {
  pi: ExtensionAPI;
  getLoopScope: () => LoopScope;
  getPiLoopEnv: () => string | undefined;
  getSessionGeneration: () => number;
  advanceSessionGeneration: () => number;
  recreateSessionStore: (sessionId: string) => void;
  clearAllLoops: () => void;
  getStore: () => LoopStore;
  getScheduler: () => { nextFire(id: string): number | undefined; pump(now: number, filter?: (entry: { id: string }) => boolean): void };
  getTriggerSystem: () => { start(): void; stop(): void };
  setLatestCtx: (ctx: ExtensionContext) => void;
  setSessionId: (sessionId: string | undefined) => void;
  widget: { setUICtx(ui: ExtensionContext["ui"]): void; update(): void };
  notificationRuntime: NotificationRuntime;
  flushPendingNotifications: (options?: { ignorePendingMessages?: boolean }) => Promise<void>;
  migrateTaskBacklogLoops: () => number;
  cleanupTaskBacklogLoops: (isCurrent?: () => boolean) => Promise<number>;
  adoptTaskBacklogLoops: (baselineFireCounts?: ReadonlyMap<string, number>, isCurrent?: () => boolean) => Promise<number>;
  releaseTaskBacklogWakes: () => void;
  clearWorkflowMonitorWaits: () => void;
  recoverOrchestrations: () => Promise<void>;
  pumpOrchestrations: () => Promise<void>;
  shutdownOrchestrations: () => Promise<void>;
  shutdownMonitors: () => Promise<void>;
  hasPendingTasks: () => Promise<number>;
  cleanDoneTasks: () => Promise<void>;
  isContextCurrent: () => boolean;
  emitLoopExpired: (
    entry: LoopEntry,
    disposition: LoopExpiryDisposition,
    reason: LoopExpiryReason,
    generation: number,
  ) => void;
}

export function registerSessionRuntimeHooks(options: SessionRuntimeOptions): void {
  const {
    pi,
    getLoopScope,
    getPiLoopEnv,
    getSessionGeneration,
    advanceSessionGeneration,
    recreateSessionStore,
    clearAllLoops,
    getStore,
    getScheduler,
    getTriggerSystem,
    setLatestCtx,
    setSessionId,
    widget,
    notificationRuntime,
    flushPendingNotifications,
    migrateTaskBacklogLoops,
    cleanupTaskBacklogLoops,
    adoptTaskBacklogLoops,
    releaseTaskBacklogWakes,
    clearWorkflowMonitorWaits,
    recoverOrchestrations,
    pumpOrchestrations,
    shutdownOrchestrations,
    shutdownMonitors,
    hasPendingTasks,
    cleanDoneTasks,
    isContextCurrent,
    emitLoopExpired,
  } = options;

  let storeUpgraded = false;
  let persistedShown = false;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let agentStartFireCounts: ReadonlyMap<string, number> | undefined;

  const isCurrentGeneration = (generation: number) => generation === getSessionGeneration();

  // The CronScheduler is pump-driven; without this heartbeat it only advances at
  // turn boundaries (turn_start/agent_end), so a loop whose fire time elapses
  // while the agent is idle would never fire and never re-wake the agent. The
  // timer is unref'd so it never keeps a one-shot (`pi -p`) process alive.
  function ensureHeartbeat(): void {
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(() => {
      const generation = getSessionGeneration();
      void pumpLoops(generation)
        .catch(() => {})
        .then(() => {
          if (isCurrentGeneration(generation)) widget.update();
        })
        .catch(() => {});
    }, HEARTBEAT_MS);
    heartbeatTimer.unref?.();
  }

  function stopHeartbeat(): void {
    if (!heartbeatTimer) return;
    clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  }

  function upgradeStoreIfNeeded(ctx: ExtensionContext) {
    if (storeUpgraded) return;
    if ((getLoopScope() === "session" || getLoopScope() === "memory") && !getPiLoopEnv()) {
      recreateSessionStore(ctx.sessionManager.getSessionId());
    }
    storeUpgraded = true;
  }

  async function showPersistedLoops(generation = getSessionGeneration()) {
    if (!isCurrentGeneration(generation) || persistedShown) return;
    persistedShown = true;
    const sessionStartedAt = Date.now();
    migrateTaskBacklogLoops();
    if (!isCurrentGeneration(generation)) return;
    clearWorkflowMonitorWaits();
    if (!isContextCurrent()) return;
    const store = getStore();
    const expired = store.expireEntries(sessionStartedAt);
    for (const record of expired) {
      if (!isCurrentGeneration(generation)) return;
      emitLoopExpired(record.entry, record.disposition, record.reason, generation);
    }
    if (!isCurrentGeneration(generation) || !isContextCurrent()) return;
    const staleEventLoops = store.expireEventLoopEntries(sessionStartedAt);
    for (const record of staleEventLoops) {
      if (!isCurrentGeneration(generation)) return;
      emitLoopExpired(record.entry, record.disposition, record.reason, generation);
    }
    await recoverOrchestrations();
    if (!isCurrentGeneration(generation)) return;
    const triggerSystem = getTriggerSystem();
    if (store.list().length > 0) {
      triggerSystem.start();
      ensureHeartbeat();
    }
    if (!isCurrentGeneration(generation)) return;
    await adoptTaskBacklogLoops(undefined, () => isCurrentGeneration(generation));
  }

  async function pumpLoops(generation = getSessionGeneration()): Promise<void> {
    await pumpOrchestrations();
    if (!isCurrentGeneration(generation)) return;
    const store = getStore();
    const scheduler = getScheduler();
    const pendingTasks = new Map<string, boolean>();
    for (const entry of store.list()) {
      if (!isCurrentGeneration(generation)) return;
      if (entry.status !== "active") continue;
      if (!entry.autoTask) continue;
      if (entry.trigger.type !== "cron" && entry.trigger.type !== "hybrid") continue;
      const nextFire = scheduler.nextFire(entry.id);
      if (!nextFire || Date.now() < nextFire) continue;
      const pending = await hasPendingTasks();
      if (!isCurrentGeneration(generation)) return;
      if (pending <= 0) pendingTasks.set(entry.id, true);
    }
    if (!isCurrentGeneration(generation)) return;
    scheduler.pump(Date.now(), (entry) => !pendingTasks.has(entry.id));
  }

  pi.on("session_start", async (_event, ctx) => {
    const generation = getSessionGeneration();
    setLatestCtx(ctx);
    setSessionId(ctx.sessionManager.getSessionId());
    widget.setUICtx(ctx.ui);
    upgradeStoreIfNeeded(ctx);
    ensureHeartbeat();
    await showPersistedLoops(generation);
    if (isCurrentGeneration(generation)) widget.update();
  });

  pi.on("turn_start", async (_event, ctx) => {
    const generation = getSessionGeneration();
    setLatestCtx(ctx);
    setSessionId(ctx.sessionManager.getSessionId());
    widget.setUICtx(ctx.ui);
    upgradeStoreIfNeeded(ctx);
    ensureHeartbeat();
    await showPersistedLoops(generation);
    if (!isCurrentGeneration(generation)) return;
    widget.update();
    await pumpLoops(generation);
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    const generation = getSessionGeneration();
    setLatestCtx(ctx);
    widget.setUICtx(ctx.ui);
    upgradeStoreIfNeeded(ctx);
    ensureHeartbeat();
    await showPersistedLoops(generation);
    if (isCurrentGeneration(generation)) widget.update();
  });

  pi.on("agent_start", async (_event, ctx) => {
    notificationRuntime.syncRuntimeState({
      agentRunning: true,
      hasPendingMessages: ctx.hasPendingMessages(),
    });
    setLatestCtx(ctx);
    widget.setUICtx(ctx.ui);
    agentStartFireCounts = new Map(getStore().list().map((entry) => [entry.id, entry.fireCount ?? 0]));
  });

  pi.on("agent_end", async (_event, ctx) => {
    const generation = getSessionGeneration();
    setLatestCtx(ctx);
    widget.setUICtx(ctx.ui);
    notificationRuntime.syncRuntimeState({
      agentRunning: false,
      hasPendingMessages: ctx.hasPendingMessages(),
    });
    releaseTaskBacklogWakes();
    await cleanupTaskBacklogLoops(() => isCurrentGeneration(generation));
    if (!isCurrentGeneration(generation)) return;
    await adoptTaskBacklogLoops(agentStartFireCounts, () => isCurrentGeneration(generation));
    if (!isCurrentGeneration(generation)) return;
    agentStartFireCounts = undefined;
    await pumpOrchestrations();
    if (!isCurrentGeneration(generation)) return;
    await flushPendingNotifications({ ignorePendingMessages: true });
    if (!isCurrentGeneration(generation)) return;
    await pumpLoops(generation);
  });

  pi.on("session_shutdown", async () => {
    advanceSessionGeneration();
    clearWorkflowMonitorWaits();
    getTriggerSystem().stop();
    stopHeartbeat();
    releaseTaskBacklogWakes();
    notificationRuntime.clear("session_shutdown");
    await Promise.all([shutdownMonitors(), shutdownOrchestrations()]);
    setSessionId(undefined);
    storeUpgraded = false;
    persistedShown = false;
    agentStartFireCounts = undefined;
  });

  pi.on("session_switch" as never, async (event: SessionSwitchEvent, ctx: ExtensionContext) => {
    const generation = advanceSessionGeneration();
    clearWorkflowMonitorWaits();
    getTriggerSystem().stop();
    stopHeartbeat();
    notificationRuntime.clear("session_switch");
    releaseTaskBacklogWakes();
    await Promise.all([shutdownMonitors(), shutdownOrchestrations()]);
    setSessionId(undefined);
    storeUpgraded = false;
    persistedShown = false;
    if (!isCurrentGeneration(generation)) return;

    setLatestCtx(ctx);
    widget.setUICtx(ctx.ui);
    const isResume = event?.reason === "resume";
    setSessionId(ctx.sessionManager.getSessionId());
    upgradeStoreIfNeeded(ctx);
    if (!isResume && getLoopScope() === "memory") clearAllLoops();
    await showPersistedLoops(generation);
    if (isCurrentGeneration(generation)) widget.update();
  });

  pi.on("tool_execution_end", async (event: unknown, ctx: ExtensionContext) => {
    setLatestCtx(ctx);
    widget.setUICtx(ctx.ui);

    const typed = event as {
      toolName?: string;
      isError?: boolean;
      args?: { command?: string };
      input?: { command?: string };
    };

    if (typed.toolName !== "bash" || typed.isError) return;

    const command = typed.args?.command ?? typed.input?.command;
    if (typeof command !== "string") return;
    if (!/^\s*git\s+commit\b/i.test(command)) return;

    await cleanDoneTasks();
  });
}
