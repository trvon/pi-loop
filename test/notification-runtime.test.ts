import { describe, expect, it, vi } from "vitest";
import { createOrchestrationState } from "../src/orchestration-reducer.js";
import { createNotificationRuntime } from "../src/runtime/notification-runtime.js";
import { createMockPi } from "./helpers/mock-pi.js";

describe("notification runtime session boundary", () => {
  it("delivers an explicit recurring-loop expiry notification", async () => {
    const { pi, sentMessages } = createMockPi();
    const runtime = createNotificationRuntime({
      pi,
      hasPendingTasks: vi.fn(async () => 0),
      cleanDoneTasks: vi.fn(async () => {}),
      getHasPendingMessages: () => false,
    });
    runtime.syncRuntimeState({ agentRunning: false, hasPendingMessages: false });

    await runtime.queueOrDeliverLoopExpired({
      loopId: "7",
      prompt: "Daily release check",
      trigger: { type: "cron", schedule: "0 8 * * *" },
      recurring: true,
      createdAt: 100,
      expiresAt: 200,
      expiredAt: 201,
      disposition: "deleted",
      source: "scheduler",
      reason: "expires_at",
    });

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].message.content).toContain("Loop #7 expired and was deleted");
    expect(sentMessages[0].message.content).toContain("Daily release check");
    expect(sentMessages[0].message.content).toContain("Recreate it explicitly if this controller is still required");
  });

  it("explains stale event-loop retirement during session recovery", async () => {
    const { pi, sentMessages } = createMockPi();
    const runtime = createNotificationRuntime({
      pi,
      hasPendingTasks: vi.fn(async () => 0),
      cleanDoneTasks: vi.fn(async () => {}),
      getHasPendingMessages: () => false,
    });

    await runtime.queueOrDeliverLoopExpired({
      loopId: "9",
      prompt: "Wait for deploy",
      trigger: { type: "event", source: "deploy:finished" },
      recurring: true,
      createdAt: 100,
      expiresAt: 10_000,
      expiredAt: 201,
      disposition: "deleted",
      source: "session_recovery",
      reason: "resume_event_stale",
    });

    expect(sentMessages[0].message.content).toContain("retired during session recovery and was deleted");
    expect(sentMessages[0].message.content).toContain("Event and hybrid subscriptions do not resume across sessions");
    expect(sentMessages[0].message.content).not.toContain("Expiry boundary");
  });

  it("drops an expiry notification from a stale session generation", async () => {
    const { pi, sentMessages } = createMockPi();
    const runtime = createNotificationRuntime({
      pi,
      hasPendingTasks: vi.fn(async () => 0),
      cleanDoneTasks: vi.fn(async () => {}),
      getHasPendingMessages: () => false,
    });
    runtime.clear("session_switch");

    await runtime.queueOrDeliverLoopExpired({
      loopId: "7",
      prompt: "Old schedule",
      trigger: { type: "cron", schedule: "0 8 * * *" },
      recurring: true,
      createdAt: 100,
      expiresAt: 200,
      expiredAt: 201,
      disposition: "deleted",
      source: "scheduler",
      reason: "expires_at",
      sessionGeneration: 0,
    });

    expect(sentMessages).toEqual([]);
  });

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

  it("acknowledges durable orchestration wake state only after message delivery", async () => {
    const { pi, sentMessages } = createMockPi();
    const delivered = vi.fn();
    const runtime = createNotificationRuntime({
      pi,
      hasPendingTasks: vi.fn(async () => 0),
      cleanDoneTasks: vi.fn(async () => {}),
      getHasPendingMessages: () => false,
      onLoopNotificationDelivered: delivered,
    });
    const orchestration = createOrchestrationState(
      { goal: "Parallel review", work: [{ prompt: "Inspect API", agentType: "Explore" }] },
      { sessionId: "s", runtimeId: "r", generation: 0 },
      100,
    );
    orchestration.status = "completed";
    orchestration.work[0]!.status = "completed";
    orchestration.pendingWake = { reason: "completed", sequence: 3, createdAt: 101 };

    runtime.syncRuntimeState({ agentRunning: true });
    await runtime.queueOrDeliverNotification({
      loopId: "7",
      prompt: "Parallel review",
      trigger: { type: "dynamic" },
      timestamp: 102,
      recurring: true,
      orchestration,
      orchestrationWakeSequence: 3,
    });
    expect(sentMessages).toHaveLength(0);
    expect(delivered).not.toHaveBeenCalled();

    runtime.syncRuntimeState({ agentRunning: false, hasPendingMessages: false });
    await runtime.flushPendingNotifications({ ignorePendingMessages: true });

    expect(sentMessages[0].message.content).toContain("Orchestration #7 complete");
    expect(sentMessages[0].message.content).toContain("Status: complete");
    expect(sentMessages[0].message.content).toContain("Progress: 1/1 complete · 0 running");
    expect(sentMessages[0].message.content).not.toContain("requires parent attention");
    expect(delivered).toHaveBeenCalledWith({ loopId: "7", orchestrationWakeSequence: 3 });
  });

  it("bounds aggregate orchestration wake evidence while preserving retrieval guidance", async () => {
    const { pi, sentMessages } = createMockPi();
    const runtime = createNotificationRuntime({
      pi,
      hasPendingTasks: vi.fn(async () => 0),
      cleanDoneTasks: vi.fn(async () => {}),
      getHasPendingMessages: () => false,
    });
    const orchestration = createOrchestrationState({
      goal: "Large review batch",
      work: Array.from({ length: 32 }, (_, index) => ({ prompt: `Inspect ${index + 1}` })),
    }, { sessionId: "s", runtimeId: "r", generation: 0 }, 100);
    orchestration.status = "completed";
    for (const [index, item] of orchestration.work.entries()) {
      item.status = "completed";
      item.attemptCount = 1;
      item.dispatches.push({
        dispatchId: `dispatch-${index}`,
        agentId: `agent-${index}`,
        attempt: 1,
        ownerRuntimeId: "r",
        ownerGeneration: 0,
        status: "completed",
        requestedAt: 100,
        settledAt: 101,
        result: "x".repeat(8_192),
        consumeStatus: "consumed",
        consumeAttempts: 1,
      });
    }

    await runtime.queueOrDeliverNotification({
      loopId: "9",
      prompt: orchestration.goal,
      trigger: { type: "dynamic" },
      timestamp: 102,
      recurring: true,
      orchestration,
      orchestrationWakeSequence: 1,
    });

    const content = sentMessages[0].message.content as string;
    expect(content.length).toBeLessThanOrEqual(12_288);
    expect(content).toContain("work item(s) omitted");
    expect(content).toContain("Use OrchestrationGet");
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
