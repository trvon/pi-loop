import { describe, expect, it, vi } from "vitest";
import { createOrchestrationState } from "../src/orchestration-reducer.js";
import { createNotificationRuntime } from "../src/runtime/notification-runtime.js";
import { LoopStore } from "../src/store.js";
import type { LoopEntry } from "../src/types.js";
import { createMockPi } from "./helpers/mock-pi.js";

describe("notification runtime session boundary", () => {
  it.each(["delete", "pause", "complete"] as const)("AUD-04: explicit %s invalidates a buffered loop wake", async (action) => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const { pi, sentMessages } = createMockPi();
      const store = new LoopStore();
      const entry = store.create(action === "complete" ? { type: "dynamic" } : { type: "cron", schedule: "* * * * *" }, "Cancelled work", {
        recurring: true,
        ...(action === "complete" ? { dynamic: { goal: "Cancelled work", awaitingUpdate: false } } : {}),
      });
      const runtime = createNotificationRuntime({
        pi,
        hasPendingTasks: async () => 0,
        cleanDoneTasks: async () => {},
        getHasPendingMessages: () => false,
        getLoop: (id) => store.get(id),
      });
      runtime.syncRuntimeState({ agentRunning: true });
      store.fire(entry.id);
      await runtime.queueOrDeliverNotification({
        loopId: entry.id,
        prompt: entry.prompt,
        trigger: entry.trigger,
        timestamp: 1_000,
        expiresAt: entry.expiresAt,
        recurring: true,
        dynamic: entry.dynamic,
        controllerStatus: "active",
      });
      expect(sentMessages).toEqual([]);
      if (action === "pause") store.pause(entry.id);
      else if (action === "complete") {
        const current = store.get(entry.id)!;
        expect(store.stopDynamic(entry.id, "completed", {
          status: current.status, iteration: current.dynamic!.iteration, updatedAt: current.updatedAt,
        })).toBe(true);
      } else store.delete(entry.id);
      runtime.syncRuntimeState({ agentRunning: false, hasPendingMessages: false });
      await runtime.flushPendingNotifications({ ignorePendingMessages: true });

      expect(sentMessages).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a buffered wake after the controller fires again", async () => {
    const { pi, sentMessages } = createMockPi();
    const store = new LoopStore();
    const entry = store.create({ type: "cron", schedule: "* * * * *" }, "Old work", {
      recurring: true,
      maxFires: 3,
    });
    const first = store.fire(entry.id)!;
    const runtime = createNotificationRuntime({
      pi,
      hasPendingTasks: async () => 0,
      cleanDoneTasks: async () => {},
      getHasPendingMessages: () => false,
      getLoop: (id) => store.get(id),
    });
    runtime.syncRuntimeState({ agentRunning: true });
    await runtime.queueOrDeliverNotification({
      loopId: first.id,
      prompt: first.prompt,
      trigger: first.trigger,
      timestamp: first.updatedAt,
      recurring: true,
      controllerStatus: first.status,
      fireCount: first.fireCount,
    });
    store.fire(entry.id);
    runtime.syncRuntimeState({ agentRunning: false, hasPendingMessages: false });
    await runtime.flushPendingNotifications({ ignorePendingMessages: true });

    expect(sentMessages).toEqual([]);
  });

  it.each(["one-shot", "fire-cap"] as const)("delivers a legitimate %s final fire after controller cleanup", async (kind) => {
    const { pi, sentMessages } = createMockPi();
    const store = new LoopStore();
    const entry = store.create({ type: "cron", schedule: "* * * * *" }, "Final work", {
      recurring: kind === "fire-cap",
      ...(kind === "fire-cap" ? { maxFires: 1 } : {}),
    });
    const fired = store.fire(entry.id)!;
    if (kind === "one-shot") store.delete(entry.id);
    const runtime = createNotificationRuntime({
      pi,
      hasPendingTasks: async () => 0,
      cleanDoneTasks: async () => {},
      getHasPendingMessages: () => false,
      getLoop: (id) => store.get(id),
    });
    runtime.syncRuntimeState({ agentRunning: true });
    await runtime.queueOrDeliverNotification({
      loopId: fired.id,
      prompt: fired.prompt,
      trigger: fired.trigger,
      timestamp: fired.updatedAt,
      recurring: fired.recurring,
      controllerStatus: fired.status,
      fireLimitReached: kind === "fire-cap",
    });
    runtime.syncRuntimeState({ agentRunning: false, hasPendingMessages: false });
    await runtime.flushPendingNotifications({ ignorePendingMessages: true });

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]?.message.content).toContain("Final work");
  });

  it("AUD-05: a task lookup finishing while busy retains the wake for exactly one idle delivery", async () => {
    const { pi, sentMessages } = createMockPi();
    let entered!: () => void;
    let release!: (count: number) => void;
    const lookupEntered = new Promise<void>((resolve) => { entered = resolve; });
    const lookupReply = new Promise<number>((resolve) => { release = resolve; });
    const runtime = createNotificationRuntime({
      pi,
      hasPendingTasks: () => { entered(); return lookupReply; },
      cleanDoneTasks: async () => {},
      getHasPendingMessages: () => false,
    });
    runtime.syncRuntimeState({ agentRunning: false, hasPendingMessages: false });
    const delivering = runtime.queueOrDeliverNotification({
      loopId: "1",
      prompt: "Adopt pending work",
      trigger: { type: "cron", schedule: "* * * * *" },
      timestamp: 1_000,
      autoTask: true,
      recurring: true,
    });
    await lookupEntered;
    runtime.syncRuntimeState({ agentRunning: true });
    release(1);
    await delivering;
    const deliveriesWhileBusy = sentMessages.length;

    runtime.syncRuntimeState({ agentRunning: false, hasPendingMessages: false });
    await runtime.flushPendingNotifications({ ignorePendingMessages: true });
    const deliveriesAfterIdle = sentMessages.length;
    runtime.syncRuntimeState({ agentRunning: false, hasPendingMessages: false });
    await runtime.flushPendingNotifications({ ignorePendingMessages: true });

    expect.soft(deliveriesWhileBusy).toBe(0);
    expect.soft(deliveriesAfterIdle - deliveriesWhileBusy).toBe(1);
    expect.soft(sentMessages).toHaveLength(1);
    expect.soft(sentMessages[0]?.message.content).toContain("Adopt pending work");
  });

  it("supersession: an older in-flight same-key wake cannot deliver after a newer wake queues while idle", async () => {
    const { pi, sentMessages } = createMockPi();
    let entered!: () => void;
    let release!: () => void;
    let lookupCount = 0;
    const lookupEntered = new Promise<void>((resolve) => { entered = resolve; });
    const delayedLookup = new Promise<number>((resolve) => { release = () => resolve(1); });
    const runtime = createNotificationRuntime({
      pi,
      hasPendingTasks: () => {
        lookupCount += 1;
        if (lookupCount !== 1) return Promise.resolve(1);
        entered();
        return delayedLookup;
      },
      cleanDoneTasks: async () => {},
      getHasPendingMessages: () => false,
    });
    runtime.syncRuntimeState({ agentRunning: false, hasPendingMessages: false });

    const oldWake = runtime.queueOrDeliverNotification({
      loopId: "1", prompt: "Old instructions", trigger: { type: "cron", schedule: "* * * * *" },
      timestamp: 1, autoTask: true, recurring: true,
    });
    await lookupEntered;
    const newWake = runtime.queueOrDeliverNotification({
      loopId: "1", prompt: "New instructions", trigger: { type: "cron", schedule: "* * * * *" },
      timestamp: 2, autoTask: true, recurring: true,
    });
    release();
    await Promise.all([oldWake, newWake]);

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]?.message.content).toContain("New instructions");
    expect(sentMessages[0]?.message.content).not.toContain("Old instructions");
  });

  it("RA-04: busy retention preserves a newer same-key wake", async () => {
    const { pi, sentMessages } = createMockPi();
    let entered!: () => void;
    let release!: () => void;
    let first = true;
    const lookupEntered = new Promise<void>((resolve) => { entered = resolve; });
    const delayedLookup = new Promise<number>((resolve) => { release = () => resolve(1); });
    const runtime = createNotificationRuntime({
      pi,
      hasPendingTasks: () => {
        if (!first) return Promise.resolve(1);
        first = false;
        entered();
        return delayedLookup;
      },
      cleanDoneTasks: async () => {},
      getHasPendingMessages: () => false,
    });
    runtime.syncRuntimeState({ agentRunning: false, hasPendingMessages: false });
    const oldWake = runtime.queueOrDeliverNotification({
      loopId: "1", prompt: "Old instructions", trigger: { type: "cron", schedule: "* * * * *" },
      timestamp: 1, autoTask: true, recurring: true,
    });
    await lookupEntered;
    runtime.syncRuntimeState({ agentRunning: true });
    const newWake = runtime.queueOrDeliverNotification({
      loopId: "1", prompt: "New instructions", trigger: { type: "cron", schedule: "* * * * *" },
      timestamp: 2, autoTask: true, recurring: true,
    });
    release();
    await Promise.all([oldWake, newWake]);
    runtime.syncRuntimeState({ agentRunning: false, hasPendingMessages: false });
    await runtime.flushPendingNotifications({ ignorePendingMessages: true });

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]?.message.content).toContain("New instructions");
    expect(sentMessages[0]?.message.content).not.toContain("Old instructions");
  });

  it("RA-07: monitor attachment invalidates a buffered workflow wake", async () => {
    const { pi, sentMessages } = createMockPi();
    const store = new LoopStore();
    const entry = store.create({ type: "dynamic" }, "Wait for monitor", {
      recurring: true,
      workflow: {
        version: 1,
        initialState: "wait",
        states: {
          wait: { prompt: "Do not run before the monitor.", on: { done: "done" } },
          done: { prompt: "Done.", terminal: "completed" },
        },
      },
    });
    const runtime = createNotificationRuntime({
      pi,
      hasPendingTasks: async () => 0,
      cleanDoneTasks: async () => {},
      getHasPendingMessages: () => false,
      getLoop: (id) => store.get(id),
    });
    runtime.syncRuntimeState({ agentRunning: true });
    await runtime.queueOrDeliverNotification({
      loopId: entry.id,
      prompt: entry.prompt,
      trigger: entry.trigger,
      timestamp: entry.updatedAt,
      recurring: true,
      controllerStatus: entry.status,
      workflow: entry.workflow,
    });
    expect(store.attachWorkflowMonitor(entry.id, "monitor-1", {
      stateId: "wait",
      transitionSeq: 0,
      definitionRevision: 1,
    })).toBeDefined();
    runtime.syncRuntimeState({ agentRunning: false, hasPendingMessages: false });
    await runtime.flushPendingNotifications({ ignorePendingMessages: true });

    expect(sentMessages).toEqual([]);
  });

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

  it("drops a buffered ordinary wake after its absolute expiry boundary", async () => {
    const { pi, sentMessages } = createMockPi();
    const runtime = createNotificationRuntime({
      pi,
      hasPendingTasks: vi.fn(async () => 0),
      cleanDoneTasks: vi.fn(async () => {}),
      getHasPendingMessages: () => false,
    });

    runtime.syncRuntimeState({ agentRunning: true });
    await runtime.queueOrDeliverNotification({
      loopId: "7",
      prompt: "Check release",
      trigger: { type: "cron", schedule: "*/5 * * * *" },
      timestamp: Date.now() - 2,
      expiresAt: Date.now() - 1,
      recurring: true,
    });
    runtime.syncRuntimeState({ agentRunning: false, hasPendingMessages: false });
    await runtime.flushPendingNotifications({ ignorePendingMessages: true });

    expect(sentMessages).toHaveLength(0);
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
    expect(sentMessages[0].message.content).toContain("Progress: 1/1 complete · 0 reserved");
    expect(sentMessages[0].message.content).not.toContain("requires parent attention");
    expect(delivered).toHaveBeenCalledWith({ loopId: "7", orchestrationWakeSequence: 3 });
  });

  it("drops a buffered orchestration wake after controller expiry", async () => {
    const { pi, sentMessages } = createMockPi();
    const delivered = vi.fn();
    const orchestration = createOrchestrationState(
      { goal: "Parallel review", work: [{ prompt: "Inspect API", agentType: "Explore" }] },
      { sessionId: "s", runtimeId: "r", generation: 0 },
      100,
    );
    orchestration.status = "completed";
    orchestration.work[0]!.status = "completed";
    orchestration.pendingWake = { reason: "completed", sequence: 3, createdAt: 101 };
    const current = {
      id: "7",
      status: "active",
      orchestration,
    } as LoopEntry;
    const runtime = createNotificationRuntime({
      pi,
      hasPendingTasks: vi.fn(async () => 0),
      cleanDoneTasks: vi.fn(async () => {}),
      getHasPendingMessages: () => false,
      getLoop: () => current,
      onLoopNotificationDelivered: delivered,
    });

    runtime.syncRuntimeState({ agentRunning: true });
    await runtime.queueOrDeliverNotification({
      loopId: "7",
      prompt: "Parallel review",
      trigger: { type: "dynamic" },
      timestamp: 102,
      recurring: true,
      controllerStatus: "active",
      orchestration: structuredClone(orchestration),
      orchestrationWakeSequence: 3,
    });
    current.status = "paused";
    current.orchestration.status = "cancelled";
    current.orchestration.pendingWake = undefined;

    runtime.syncRuntimeState({ agentRunning: false, hasPendingMessages: false });
    await runtime.flushPendingNotifications({ ignorePendingMessages: true });

    expect(sentMessages).toHaveLength(0);
    expect(delivered).not.toHaveBeenCalled();
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
