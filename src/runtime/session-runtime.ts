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
  cleanupTaskBacklogLoops: () => Promise<number>;
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
    cleanupTaskBacklogLoops,
    hasPendingTasks,
    cleanDoneTasks,
  } = options;

  let storeUpgraded = false;
  let persistedShown = false;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  // The CronScheduler is pump-driven; without this heartbeat it only advances at
  // turn boundaries (turn_start/agent_end), so a loop whose fire time elapses
  // while the agent is idle would never fire and never re-wake the agent. The
  // timer is unref'd so it never keeps a one-shot (`pi -p`) process alive.
  function ensureHeartbeat(): void {
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(() => {
      void pumpLoops();
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
    if (getLoopScope() === "session" && !getPiLoopEnv()) {
      recreateSessionStore(ctx.sessionManager.getSessionId());
    }
    storeUpgraded = true;
  }

  function showPersistedLoops(_isResume = false) {
    if (persistedShown) return;
    persistedShown = true;
    const sessionStartedAt = Date.now();
    const loops = getStore().list();
    if (loops.length > 0) {
      getStore().clearExpired();
      getStore().expireEventLoops(sessionStartedAt);
      getTriggerSystem().start();
      ensureHeartbeat();
      widget.update();
    }
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

  pi.on("turn_start", async (_event, ctx) => {
    setLatestCtx(ctx);
    setSessionId(ctx.sessionManager.getSessionId());
    widget.setUICtx(ctx.ui);
    upgradeStoreIfNeeded(ctx);
    ensureHeartbeat();
    widget.update();
    await pumpLoops();
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    setLatestCtx(ctx);
    widget.setUICtx(ctx.ui);
    upgradeStoreIfNeeded(ctx);
    ensureHeartbeat();
    showPersistedLoops();
    widget.update();
  });

  pi.on("agent_start", async (_event, ctx) => {
    notificationRuntime.syncRuntimeState({
      agentRunning: true,
      hasPendingMessages: ctx.hasPendingMessages(),
    });
    setLatestCtx(ctx);
    widget.setUICtx(ctx.ui);
  });

  pi.on("agent_end", async (_event, ctx) => {
    setLatestCtx(ctx);
    widget.setUICtx(ctx.ui);
    notificationRuntime.syncRuntimeState({
      agentRunning: false,
      hasPendingMessages: ctx.hasPendingMessages(),
    });
    await flushPendingNotifications({ ignorePendingMessages: true });
    await cleanupTaskBacklogLoops();
    await pumpLoops();
  });

  pi.on("session_shutdown", async () => {
    stopHeartbeat();
    notificationRuntime.clear("session_shutdown");
  });

  pi.on("session_switch" as never, async (event: SessionSwitchEvent, ctx: ExtensionContext) => {
    setLatestCtx(ctx);
    widget.setUICtx(ctx.ui);
    getTriggerSystem().stop();
    stopHeartbeat();
    notificationRuntime.clear("session_switch");
    setSessionId(undefined);

    const isResume = event?.reason === "resume";
    storeUpgraded = false;
    persistedShown = false;

    if (!isResume && getLoopScope() === "memory") {
      clearAllLoops();
    }

    upgradeStoreIfNeeded(ctx);
    showPersistedLoops(isResume);
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
