import { describe, expect, it, vi } from "vitest";
import { createNotificationRuntime } from "../src/runtime/notification-runtime.js";
import { createMockPi } from "./helpers/mock-pi.js";

describe("notification runtime session boundary", () => {
  it("drops a wake whose task lookup completes after session shutdown", async () => {
    const { pi, sentMessages } = createMockPi();
    let resolvePending: ((pending: number) => void) | undefined;
    let notifyPendingLookup: (() => void) | undefined;
    const pendingLookupStarted = new Promise<void>((resolve) => {
      notifyPendingLookup = resolve;
    });
    const pendingTasks = new Promise<number>((resolve) => {
      resolvePending = resolve;
    });
    const runtime = createNotificationRuntime({
      pi,
      hasPendingTasks: vi.fn(() => {
        notifyPendingLookup?.();
        return pendingTasks;
      }),
      cleanDoneTasks: vi.fn(async () => {}),
      getHasPendingMessages: () => false,
    });

    const queued = runtime.queueOrDeliverNotification({
      loopId: "42",
      prompt: "This wake belongs to the closed session",
      trigger: { type: "cron", schedule: "*/5 * * * *" },
      timestamp: 100,
      autoTask: true,
      recurring: false,
    });
    await pendingLookupStarted;

    runtime.clear("session_shutdown");
    resolvePending?.(1);
    await queued;

    expect(sentMessages).toEqual([]);
  });

  it("drops an old-session monitor start while delivering the current-session start", async () => {
    const { pi, sentMessages } = createMockPi();
    const runtime = createNotificationRuntime({
      pi,
      hasPendingTasks: vi.fn(async () => 0),
      cleanDoneTasks: vi.fn(async () => {}),
      getHasPendingMessages: () => false,
    });

    runtime.clear("session_shutdown");
    await runtime.queueOrDeliverMonitorStarted({
      monitorId: "old",
      command: "npm test",
      timestamp: 100,
      sessionGeneration: 0,
    });
    await runtime.queueOrDeliverMonitorStarted({
      monitorId: "current",
      command: "npm run build",
      timestamp: 101,
      sessionGeneration: 1,
    });
    await runtime.flushPendingNotifications({ ignorePendingMessages: true });

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].message.content).toContain("Monitor #current started");
  });
});
