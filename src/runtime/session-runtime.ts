import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { LoopStore } from "../store.js";
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
  cleanupTaskBacklogLoops: () => Promise<number>;
  adoptTaskBacklogLoops: (baselineFireCounts?: ReadonlyMap<string, number>) => Promise<number>;
  releaseTaskBacklogWakes: () => void;
  clearWorkflowMonitorWaits: () => void;
  shutdownMonitors: () => Promise<void>;
  hasPendingTasks: () => Promise<number>;
  cleanDoneTasks: () => Promise<void>;
}

export function registerSessionRuntimeHooks(options: SessionRuntimeOptions): void {
  const {
    pi,
    getLoopScope,
    getPiLoopEnv,
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
    shutdownMonitors,
    hasPendingTasks,
    cleanDoneTasks,
  } = options;

  let storeUpgraded = false;
  let persistedShown = false;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let agentStartFireCounts: ReadonlyMap<string, number> | undefined;

  // The CronScheduler is pump-driven; without this heartbeat it only advances at
  // turn boundaries (turn_start/agent_end), so a loop whose fire time elapses
  // while the agent is idle would never fire and never re-wake the agent. The
  // timer is unref'd so it never keeps a one-shot (`pi -p`) process alive.
  function ensureHeartbeat(): void {
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(() => {
      // Swallow pump failures so a transient error never surfaces as an
      // unhandled rejection; repaint still runs so cleared harness UI heals.
      void pumpLoops()
        .catch(() => {})
        .then(() => widget.update())
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

  async function showPersistedLoops(_isResume = false) {
    if (persistedShown) return;
    persistedShown = true;
    const sessionStartedAt = Date.now();
    migrateTaskBacklogLoops();
    clearWorkflowMonitorWaits();
    const loops = getStore().list();
    if (loops.length > 0) {
      getStore().clearExpired();
      getStore().expireEventLoops(sessionStartedAt);
      getTriggerSystem().start();
      ensureHeartbeat();
    }
    await adoptTaskBacklogLoops();
  }

  async function pumpLoops(): Promise<void> {
    const pendingTasks = new Map<string, boolean>();
    for (const entry of getStore().list()) {
      if (entry.status !== "active") continue;
      if (!entry.autoTask) continue;
      if (entry.trigger.type !== "cron" && entry.trigger.type !== "hybrid") continue;
      const nextFire = getScheduler().nextFire(entry.id);
      if (!nextFire || Date.now() < nextFire) continue;
      const pending = await hasPendingTasks();
      if (pending <= 0) pendingTasks.set(entry.id, true);
    }
    getScheduler().pump(Date.now(), (entry) => !pendingTasks.has(entry.id));
  }

  pi.on("session_start", async (_event, ctx) => {
    setLatestCtx(ctx);
    setSessionId(ctx.sessionManager.getSessionId());
    widget.setUICtx(ctx.ui);
    upgradeStoreIfNeeded(ctx);
    ensureHeartbeat();
    await showPersistedLoops();
    widget.update();
  });

  pi.on("turn_start", async (_event, ctx) => {
    setLatestCtx(ctx);
    setSessionId(ctx.sessionManager.getSessionId());
    widget.setUICtx(ctx.ui);
    upgradeStoreIfNeeded(ctx);
    ensureHeartbeat();
    await showPersistedLoops();
    widget.update();
    await pumpLoops();
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    setLatestCtx(ctx);
    widget.setUICtx(ctx.ui);
    upgradeStoreIfNeeded(ctx);
    ensureHeartbeat();
    await showPersistedLoops();
    widget.update();
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
    setLatestCtx(ctx);
    widget.setUICtx(ctx.ui);
    notificationRuntime.syncRuntimeState({
      agentRunning: false,
      hasPendingMessages: ctx.hasPendingMessages(),
    });
    releaseTaskBacklogWakes();
    await cleanupTaskBacklogLoops();
    await adoptTaskBacklogLoops(agentStartFireCounts);
    agentStartFireCounts = undefined;
    await flushPendingNotifications({ ignorePendingMessages: true });
    await pumpLoops();
  });

  pi.on("session_shutdown", async () => {
    clearWorkflowMonitorWaits();
    await shutdownMonitors();
    stopHeartbeat();
    releaseTaskBacklogWakes();
    notificationRuntime.clear("session_shutdown");
  });

  pi.on("session_switch" as never, async (event: SessionSwitchEvent, ctx: ExtensionContext) => {
    clearWorkflowMonitorWaits();
    await shutdownMonitors();
    setLatestCtx(ctx);
    widget.setUICtx(ctx.ui);
    getTriggerSystem().stop();
    stopHeartbeat();
    notificationRuntime.clear("session_switch");
    releaseTaskBacklogWakes();
    setSessionId(undefined);

    const isResume = event?.reason === "resume";
    storeUpgraded = false;
    persistedShown = false;

    setSessionId(ctx.sessionManager.getSessionId());
    upgradeStoreIfNeeded(ctx);
    if (!isResume && getLoopScope() === "memory") clearAllLoops();
    await showPersistedLoops(isResume);
    widget.update();
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
