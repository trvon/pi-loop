import { afterEach, describe, expect, it, vi } from "vitest";
import { registerSessionRuntimeHooks, type SessionRuntimeOptions } from "../src/runtime/session-runtime.js";
import { createCtx, createMockPi } from "./helpers/mock-pi.js";

function setup(overrides: Partial<SessionRuntimeOptions> = {}) {
  const { pi, extensionHandlers } = createMockPi();
  let sessionGeneration = 0;
  const scheduler = { nextFire: vi.fn(() => undefined), pump: vi.fn() };
  const options: SessionRuntimeOptions = {
    pi,
    getLoopScope: () => "memory",
    getPiLoopEnv: () => undefined,
    getSessionGeneration: () => sessionGeneration,
    advanceSessionGeneration: () => ++sessionGeneration,
    recreateSessionStore: vi.fn(),
    clearAllLoops: vi.fn(),
    getStore: () => ({
      list: () => [],
      expireEntries: vi.fn(() => []),
      expireEventLoopEntries: vi.fn(() => []),
    }) as any,
    getScheduler: () => scheduler as any,
    getTriggerSystem: () => ({ start: vi.fn(), stop: vi.fn() }),
    setLatestCtx: vi.fn(),
    setSessionId: vi.fn(),
    widget: { setUICtx: vi.fn(), update: vi.fn() },
    notificationRuntime: {
      syncRuntimeState: vi.fn(),
      queueOrDeliverNotification: vi.fn(async () => {}),
      queueOrDeliverLoopExpired: vi.fn(async () => {}),
      queueOrDeliverMonitorStarted: vi.fn(async () => {}),
      discardMonitorStarted: vi.fn(),
      flushPendingNotifications: vi.fn(async () => {}),
      clear: vi.fn(),
    },
    flushPendingNotifications: vi.fn(async () => {}),
    migrateTaskBacklogLoops: vi.fn(() => 0),
    cleanupTaskBacklogLoops: vi.fn(async () => 0),
    adoptTaskBacklogLoops: vi.fn(async () => 0),
    releaseTaskBacklogWakes: vi.fn(),
    clearWorkflowMonitorWaits: vi.fn(),
    recoverOrchestrations: vi.fn(async () => {}),
    pumpOrchestrations: vi.fn(async () => {}),
    shutdownOrchestrations: vi.fn(async () => {}),
    shutdownMonitors: vi.fn(async () => {}),
    hasPendingTasks: vi.fn(async () => 0),
    cleanDoneTasks: vi.fn(async () => {}),
    isContextCurrent: () => true,
    emitLoopExpired: vi.fn(),
    ...overrides,
  };
  registerSessionRuntimeHooks(options);
  const drive = async (name: string, sessionId = "test-session") => {
    for (const handler of extensionHandlers.get(name) ?? []) await handler(null, createCtx({ sessionId }));
  };
  return { scheduler, drive };
}

describe("session-runtime heartbeat lifecycle", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("starts an unref'd heartbeat interval on turn_start", async () => {
    const unref = vi.fn();
    const setIntervalSpy = vi.spyOn(global, "setInterval").mockReturnValue({ unref } as any);

    const { drive } = setup();
    await drive("turn_start");

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy.mock.calls[0][1]).toBe(30000);
    expect(unref).toHaveBeenCalledTimes(1); // never keeps a `pi -p` process alive
  });

  it("migrates persisted backlog prompts before starting loop triggers", async () => {
    const calls: string[] = [];
    const migrateTaskBacklogLoops = vi.fn(() => {
      calls.push("migrate");
      return 1;
    });
    const triggerSystem = {
      start: vi.fn(() => calls.push("start")),
      stop: vi.fn(),
    };
    const { drive } = setup({
      migrateTaskBacklogLoops,
      clearWorkflowMonitorWaits: vi.fn(() => calls.push("clear monitor waits")),
      recoverOrchestrations: vi.fn(async () => { calls.push("recover orchestrations"); }),
      getStore: () => ({
        list: () => [{ id: "8", status: "active" }],
        expireEntries: vi.fn(() => { calls.push("clear expired"); return []; }),
        expireEventLoopEntries: vi.fn(() => { calls.push("expire events"); return []; }),
      }) as any,
      getTriggerSystem: () => triggerSystem,
    });

    await drive("session_start");

    expect(migrateTaskBacklogLoops).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["migrate", "clear monitor waits", "clear expired", "expire events", "recover orchestrations", "start"]);
  });

  it("does not consume persisted expiry under a stale extension context", async () => {
    const expireEntries = vi.fn(() => []);
    const { drive } = setup({
      getStore: () => ({
        list: () => [],
        expireEntries,
        expireEventLoopEntries: vi.fn(() => []),
      }) as any,
      isContextCurrent: () => false,
    });

    await drive("session_start");

    expect(expireEntries).not.toHaveBeenCalled();
  });

  it("emits recovered expiries after store cleanup", async () => {
    const expired = {
      id: "8",
      prompt: "Daily release check",
      trigger: { type: "cron", schedule: "0 8 * * *" },
      status: "active",
      recurring: true,
      createdAt: 1,
      updatedAt: 1,
      expiresAt: 2,
    };
    const emitLoopExpired = vi.fn();
    const { drive } = setup({
      getStore: () => ({
        list: () => [],
        expireEntries: vi.fn(() => [{ entry: expired, disposition: "deleted", reason: "expires_at" }]),
        expireEventLoopEntries: vi.fn(() => []),
      }) as any,
      emitLoopExpired,
    });

    await drive("session_start");

    expect(emitLoopExpired).toHaveBeenCalledWith(expired, "deleted", "expires_at", 0);
  });

  it("emits stale event-loop retirement found during session recovery", async () => {
    const stale = {
      id: "9",
      prompt: "Wait for deploy",
      trigger: { type: "event", source: "deploy:finished" },
      status: "active",
      recurring: true,
      createdAt: 1,
      updatedAt: 1,
      expiresAt: Date.now() + 60_000,
    };
    const emitLoopExpired = vi.fn();
    const { drive } = setup({
      getStore: () => ({
        list: () => [],
        expireEntries: vi.fn(() => []),
        expireEventLoopEntries: vi.fn(() => [{
          entry: stale,
          disposition: "deleted",
          reason: "resume_event_stale",
        }]),
      }) as any,
      emitLoopExpired,
    });

    await drive("session_start");

    expect(emitLoopExpired).toHaveBeenCalledWith(stale, "deleted", "resume_event_stale", 0);
  });

  it("repaints the widget on session_start after the harness resets extension UI", async () => {
    const widget = { setUICtx: vi.fn(), update: vi.fn() };
    const setSessionId = vi.fn();
    const { drive } = setup({ widget, setSessionId });

    await drive("session_start");

    expect(setSessionId).toHaveBeenCalledWith("test-session");
    expect(widget.setUICtx).toHaveBeenCalledTimes(1);
    expect(widget.update).toHaveBeenCalledTimes(1);
  });

  it("binds the destination session during session_switch", async () => {
    const setSessionId = vi.fn();
    const { drive } = setup({ setSessionId });

    await drive("session_switch");

    expect(setSessionId.mock.calls).toEqual([[undefined], ["test-session"]]);
  });

  it("repaints the widget and reconciles orchestration on the existing heartbeat", async () => {
    vi.useFakeTimers();
    const widget = { setUICtx: vi.fn(), update: vi.fn() };
    const pumpOrchestrations = vi.fn(async () => {});
    const { drive } = setup({ widget, pumpOrchestrations });

    await drive("turn_start");
    widget.update.mockClear();
    pumpOrchestrations.mockClear();
    await vi.advanceTimersByTimeAsync(30000);

    expect(pumpOrchestrations).toHaveBeenCalledOnce();
    expect(widget.update).toHaveBeenCalledTimes(1);
  });

  it("is idempotent — does not start a second interval across turn boundaries", async () => {
    const setIntervalSpy = vi.spyOn(global, "setInterval").mockReturnValue({ unref: vi.fn() } as any);

    const { drive } = setup();
    await drive("before_agent_start");
    await drive("turn_start");
    await drive("turn_start");

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
  });

  it("clears the heartbeat on session_shutdown", async () => {
    const timer = { unref: vi.fn() };
    vi.spyOn(global, "setInterval").mockReturnValue(timer as any);
    const clearIntervalSpy = vi.spyOn(global, "clearInterval");

    const { drive } = setup();
    await drive("turn_start");
    await drive("session_shutdown");

    expect(clearIntervalSpy).toHaveBeenCalledWith(timer);
  });

  it("fully rebinds session-scoped runtime after shutdown", async () => {
    const recreateSessionStore = vi.fn();
    const setSessionId = vi.fn();
    const triggerSystem = { start: vi.fn(), stop: vi.fn() };
    const { drive } = setup({
      getLoopScope: () => "session",
      recreateSessionStore,
      setSessionId,
      getStore: () => ({
        list: () => [{ id: "8", status: "active" }],
        expireEntries: vi.fn(() => []),
        expireEventLoopEntries: vi.fn(() => []),
      }) as any,
      getTriggerSystem: () => triggerSystem,
    });

    await drive("session_start", "session-one");
    await drive("session_shutdown");
    await drive("session_start", "session-two");

    expect(recreateSessionStore).toHaveBeenNthCalledWith(1, "session-one");
    expect(recreateSessionStore).toHaveBeenNthCalledWith(2, "session-two");
    expect(triggerSystem.stop).toHaveBeenCalledOnce();
    expect(triggerSystem.start).toHaveBeenCalledTimes(2);
    expect(setSessionId.mock.calls).toEqual([["session-one"], [undefined], ["session-two"]]);
  });

  it("clears workflow monitor waits before stopping monitors", async () => {
    const calls: string[] = [];
    const { drive } = setup({
      clearWorkflowMonitorWaits: vi.fn(() => calls.push("clear")),
      shutdownOrchestrations: vi.fn(async () => { calls.push("stop orchestration"); }),
      shutdownMonitors: vi.fn(async () => { calls.push("shutdown monitors"); }),
    });

    await drive("session_shutdown");

    expect(calls).toEqual(["clear", "stop orchestration", "shutdown monitors"]);
  });

  it("awaits monitor shutdown before completing session shutdown", async () => {
    let resolveShutdown: (() => void) | undefined;
    const shutdownMonitors = vi.fn(() => new Promise<void>((resolve) => {
      resolveShutdown = resolve;
    }));
    const { drive } = setup({ shutdownMonitors });
    let completed = false;
    const shutdown = drive("session_shutdown").then(() => {
      completed = true;
    });

    await Promise.resolve();
    expect(shutdownMonitors).toHaveBeenCalledOnce();
    expect(completed).toBe(false);

    resolveShutdown?.();
    await shutdown;
    expect(completed).toBe(true);
  });

  it("stops monitors when switching sessions", async () => {
    const shutdownMonitors = vi.fn(async () => {});
    const { drive } = setup({ shutdownMonitors });

    await drive("session_switch");

    expect(shutdownMonitors).toHaveBeenCalledOnce();
  });

  it("does not pump a newly rebound scheduler after shutdown during task lookup", async () => {
    let resolvePending: (() => void) | undefined;
    let notifyPendingLookup: (() => void) | undefined;
    const pendingLookupStarted = new Promise<void>((resolve) => {
      notifyPendingLookup = resolve;
    });
    const pendingTasks = new Promise<number>((resolve) => {
      resolvePending = () => resolve(0);
    });
    const scheduler = { nextFire: vi.fn(() => Date.now()), pump: vi.fn() };
    const { drive } = setup({
      getStore: () => ({
        list: () => [{
          id: "8",
          status: "active",
          autoTask: true,
          trigger: { type: "cron", schedule: "*/5 * * * *" },
        }],
        expireEntries: vi.fn(() => []),
        expireEventLoopEntries: vi.fn(() => []),
      }) as any,
      getScheduler: () => scheduler as any,
      hasPendingTasks: vi.fn(() => {
        notifyPendingLookup?.();
        return pendingTasks;
      }),
    });

    const turnStart = drive("turn_start");
    await pendingLookupStarted;
    await drive("session_shutdown");
    resolvePending?.();
    await turnStart;

    expect(scheduler.pump).not.toHaveBeenCalled();
  });

  it("does not leak an unhandled rejection when a heartbeat pump throws", async () => {
    vi.useFakeTimers();
    const scheduler = {
      nextFire: vi.fn(() => undefined),
      pump: vi.fn(() => {
        throw new Error("pump boom");
      }),
    };
    const widget = { setUICtx: vi.fn(), update: vi.fn() };
    const { drive } = setup({ getScheduler: () => scheduler as any, widget });

    // before_agent_start starts the heartbeat without itself calling pumpLoops.
    await drive("before_agent_start");
    widget.update.mockClear();
    // Fire one heartbeat tick → its pumpLoops() rejects. With the `.catch`, this
    // is swallowed; without it, vitest fails the test on the unhandled rejection.
    await vi.advanceTimersByTimeAsync(30000);

    expect(scheduler.pump).toHaveBeenCalled();
    expect(widget.update).toHaveBeenCalledTimes(1);
  });
});
