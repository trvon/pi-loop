import { afterEach, describe, expect, it, vi } from "vitest";
import { registerSessionRuntimeHooks, type SessionRuntimeOptions } from "../src/runtime/session-runtime.js";
import { createCtx, createMockPi } from "./helpers/mock-pi.js";

function setup(overrides: Partial<SessionRuntimeOptions> = {}) {
  const { pi, extensionHandlers } = createMockPi();
  const scheduler = { nextFire: vi.fn(() => undefined), pump: vi.fn() };
  const options: SessionRuntimeOptions = {
    pi,
    getLoopScope: () => "memory", // skip session store recreation
    getPiLoopEnv: () => undefined,
    recreateSessionStore: vi.fn(),
    clearAllLoops: vi.fn(),
    getStore: () => ({ list: () => [], clearExpired: vi.fn(), expireEventLoops: vi.fn() }) as any,
    getScheduler: () => scheduler as any,
    getTriggerSystem: () => ({ start: vi.fn(), stop: vi.fn() }),
    setLatestCtx: vi.fn(),
    setSessionId: vi.fn(),
    widget: { setUICtx: vi.fn(), update: vi.fn() },
    notificationRuntime: {
      syncRuntimeState: vi.fn(),
      queueOrDeliverNotification: vi.fn(async () => {}),
      flushPendingNotifications: vi.fn(async () => {}),
      clear: vi.fn(),
    },
    flushPendingNotifications: vi.fn(async () => {}),
    cleanupTaskBacklogLoops: vi.fn(async () => 0),
    hasPendingTasks: vi.fn(async () => 0),
    cleanDoneTasks: vi.fn(async () => {}),
    ...overrides,
  };
  registerSessionRuntimeHooks(options);
  const drive = async (name: string) => {
    for (const handler of extensionHandlers.get(name) ?? []) await handler(null, createCtx());
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

  it("repaints the widget on session_start after the harness resets extension UI", async () => {
    const widget = { setUICtx: vi.fn(), update: vi.fn() };
    const setSessionId = vi.fn();
    const { drive } = setup({ widget, setSessionId });

    await drive("session_start");

    expect(setSessionId).toHaveBeenCalledWith("test-session");
    expect(widget.setUICtx).toHaveBeenCalledTimes(1);
    expect(widget.update).toHaveBeenCalledTimes(1);
  });

  it("repaints the widget on heartbeat to recover an externally cleared status", async () => {
    vi.useFakeTimers();
    const widget = { setUICtx: vi.fn(), update: vi.fn() };
    const { drive } = setup({ widget });

    await drive("turn_start");
    widget.update.mockClear();
    await vi.advanceTimersByTimeAsync(30000);

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
