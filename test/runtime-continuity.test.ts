import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MonitorManager } from "../src/monitor-manager.js";
import { createNotificationRuntime } from "../src/runtime/notification-runtime.js";
import { CronScheduler } from "../src/scheduler.js";
import { LoopStore } from "../src/store.js";
import { createMockPi } from "./helpers/mock-pi.js";
import { createMockChildProcess, createSequentialSpawn } from "./helpers/mock-spawn.js";

let dir: string;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:01Z"));
  dir = mkdtempSync(join(tmpdir(), "pi-loop-continuity-"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const path = join(dir, "loops.json");
  return { path, store: new LoopStore(path) };
}
function bytes(path: string) {
  return [readFileSync(path, "utf8"), readFileSync(`${path}.prev`, "utf8")];
}

// These model continuity boundaries, not OS death or unattended execution.
describe("runtime continuity expectations and invariants", () => {
  it.each(["session_switch", "session_shutdown"] as const)("clears ordinary wakes on %s without undoing persisted accounting", async (reason) => {
    const { path, store } = fixture();
    const entry = store.create({ type: "cron", schedule: "* * * * *" }, "Observe", { recurring: true });
    const fired = store.fire(entry.id)!;
    const before = bytes(path);
    const { pi, sentMessages } = createMockPi();
    const delivered = vi.fn();
    const runtime = createNotificationRuntime({
      pi, getLoop: (id) => store.get(id), getHasPendingMessages: () => false,
      hasPendingTasks: async () => 0, cleanDoneTasks: async () => {}, onLoopNotificationDelivered: delivered,
    });
    runtime.syncRuntimeState({ agentRunning: true });
    await runtime.queueOrDeliverNotification({
      loopId: entry.id, prompt: fired.prompt, trigger: fired.trigger,
      timestamp: fired.updatedAt, recurring: true, fireCount: fired.fireCount,
      controllerStatus: fired.status, controllerCreatedAt: fired.createdAt,
    });
    expect(sentMessages).toEqual([]);
    runtime.clear(reason);
    await runtime.flushPendingNotifications({ ignorePendingMessages: true });
    const peer = new LoopStore(path);
    expect(peer.get(entry.id)?.fireCount).toBe(1);
    expect(bytes(path)).toEqual(before);
    expect(sentMessages).toEqual([]);
    expect(delivered).not.toHaveBeenCalled();
    const fresh = createNotificationRuntime({
      pi, getLoop: (id) => peer.get(id), getHasPendingMessages: () => false,
      hasPendingTasks: async () => 0, cleanDoneTasks: async () => {},
    });
    await fresh.flushPendingNotifications({ ignorePendingMessages: true });
    expect(sentMessages).toEqual([]);
  });

  it("retains file-backed intent but does not schedule or dispatch until a runtime arms it", () => {
    const { path, store } = fixture();
    const entry = store.create({ type: "cron", schedule: "* * * * *" }, "Observe", { recurring: true });
    const before = readFileSync(path, "utf8");
    const peer = new LoopStore(path);
    const dispatch = vi.fn(() => true);
    const scheduler = new CronScheduler(peer, dispatch);
    try {
      vi.advanceTimersByTime(300_000);
      expect(scheduler.nextFire(entry.id)).toBeUndefined();
      expect(dispatch).not.toHaveBeenCalled();
      expect(peer.get(entry.id)?.fireCount).toBe(0);
      expect(readFileSync(path, "utf8")).toBe(before);
      scheduler.start();
      expect(scheduler.nextFire(entry.id)).toBeGreaterThan(Date.now());
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      scheduler.stop();
    }
  });

  it("does not mistake shared file state for election of one scheduler", () => {
    const { path, store } = fixture();
    const entry = store.create({ type: "cron", schedule: "* * * * *" }, "Observe", { recurring: true });
    const peer = new LoopStore(path);
    const first = new CronScheduler(store, () => true);
    const second = new CronScheduler(peer, () => true);
    try {
      first.start();
      second.start();
      expect(first.nextFire(entry.id)).toBeDefined();
      expect(second.nextFire(entry.id)).toBeDefined();
      expect(peer.get(entry.id)?.fireCount).toBe(0);
    } finally {
      first.stop();
      second.stop();
    }
  });

  it("persists orchestration wake intent across buffer clearing until exact delivery acknowledgement", async () => {
    const { path, store } = fixture();
    const owner = { sessionId: "session", runtimeId: "runtime", generation: 1 };
    const entry = store.create({ type: "dynamic" }, "Inspect", {
      recurring: true, orchestration: { owner, definition: { goal: "Inspect", work: [{ prompt: "Inspect API" }] } },
    });
    const expected = () => ({ revision: store.get(entry.id)!.orchestration!.revision, ownerRuntimeId: owner.runtimeId, generation: owner.generation });
    expect(store.mutateOrchestration(entry.id, { type: "dispatch_requested", at: Date.now(), expected: expected(), workId: "1", dispatchId: "d" }).applied).toBe(true);
    expect(store.mutateOrchestration(entry.id, { type: "dispatch_uncertain", at: Date.now(), expected: expected(), workId: "1", dispatchId: "d", error: "Unknown execution" }).applied).toBe(true);
    const current = store.get(entry.id)!;
    const sequence = current.orchestration!.pendingWake!.sequence;
    const before = bytes(path);
    const { pi, sentMessages } = createMockPi();
    const acknowledged = vi.fn();
    const runtime = createNotificationRuntime({
      pi, getLoop: (id) => store.get(id), getHasPendingMessages: () => false,
      hasPendingTasks: async () => 0, cleanDoneTasks: async () => {}, onLoopNotificationDelivered: acknowledged,
    });
    const notification = {
      loopId: entry.id, prompt: current.prompt, trigger: current.trigger,
      timestamp: current.updatedAt, recurring: true, controllerStatus: current.status,
      orchestration: current.orchestration, orchestrationWakeSequence: sequence,
    };
    runtime.syncRuntimeState({ agentRunning: true });
    await runtime.queueOrDeliverNotification(notification);
    runtime.clear("session_switch");
    expect(acknowledged).not.toHaveBeenCalled();
    expect(bytes(path)).toEqual(before);
    const peer = new LoopStore(path);
    expect(peer.get(entry.id)?.orchestration?.pendingWake?.sequence).toBe(sequence);
    const stale = peer.mutateOrchestration(entry.id, { type: "wake_acknowledged", at: Date.now(), expected: expected(), sequence: sequence + 1 });
    expect(stale.applied).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(before[0]);
    expect(peer.get(entry.id)?.orchestration?.pendingWake?.sequence).toBe(sequence);
    const recovered = createNotificationRuntime({
      pi, getLoop: (id) => peer.get(id), getHasPendingMessages: () => false,
      hasPendingTasks: async () => 0, cleanDoneTasks: async () => {},
      onLoopNotificationDelivered: (info) => {
        acknowledged(info);
        peer.mutateOrchestration(entry.id, { type: "wake_acknowledged", at: Date.now(), expected: expected(), sequence: info.orchestrationWakeSequence! });
      },
    });
    await recovered.queueOrDeliverNotification(notification);
    expect(sentMessages).toHaveLength(1);
    expect(acknowledged).toHaveBeenCalledWith({ loopId: entry.id, orchestrationWakeSequence: sequence });
    expect(new LoopStore(path).get(entry.id)?.orchestration?.pendingWake).toBeUndefined();
    expect(peer.get(entry.id)?.orchestration?.work[0]?.status).toBe("uncertain");
  });

  it("clears persisted attention wake intent on explicit controller cancellation", () => {
    const { path, store } = fixture();
    const owner = { sessionId: "session", runtimeId: "runtime", generation: 1 };
    const entry = store.create({ type: "dynamic" }, "Inspect", {
      recurring: true, orchestration: { owner, definition: { goal: "Inspect", work: [{ prompt: "Inspect API" }] } },
    });
    const expected = () => ({ revision: store.get(entry.id)!.orchestration!.revision, ownerRuntimeId: owner.runtimeId, generation: owner.generation });
    expect(store.mutateOrchestration(entry.id, { type: "dispatch_requested", at: Date.now(), expected: expected(), workId: "1", dispatchId: "d" }).applied).toBe(true);
    expect(store.mutateOrchestration(entry.id, { type: "dispatch_uncertain", at: Date.now(), expected: expected(), workId: "1", dispatchId: "d", error: "Unknown execution" }).applied).toBe(true);
    expect(new LoopStore(path).get(entry.id)?.orchestration?.pendingWake).toBeDefined();
    expect(store.mutateOrchestration(entry.id, { type: "cancelled", at: Date.now(), expected: expected() }).applied).toBe(true);
    const cancelled = new LoopStore(path).get(entry.id)?.orchestration;
    expect(cancelled?.pendingWake).toBeUndefined();
    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.work[0]?.dispatches[0]?.status).toBe("uncertain");
  });

  it("does not recover or replay an old process handle in a fresh MonitorManager", async () => {
    const { pi } = createMockPi();
    const spawn = vi.fn(createSequentialSpawn(createMockChildProcess({ stdout: ["old output"] })));
    const old = new MonitorManager(pi, spawn, { platform: "linux" });
    const fresh = new MonitorManager(pi, spawn, { platform: "linux" });
    try {
      const monitor = old.create("fixture command", "Old process");
      expect(old.get(monitor.id)).toBeDefined();
      expect(fresh.list()).toEqual([]);
      expect(fresh.get(monitor.id)).toBeUndefined();
      expect(fresh.getProcess(monitor.id)).toBeUndefined();
      expect(await fresh.stop(monitor.id)).toBe(false);
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally {
      await old.shutdown();
      await fresh.shutdown();
    }
  });

  it.each(["delete", "fire-limit", "expire"])("retains no ordinary-controller tombstone after %s", (action) => {
    const { path, store } = fixture();
    const entry = store.create({ type: "cron", schedule: "* * * * *" }, "Observe", { recurring: true, maxFires: 1, expiresIn: "1s" });
    if (action === "delete") expect(store.delete(entry.id)).toBe(true);
    else if (action === "fire-limit") expect(store.fire(entry.id)).toBeDefined();
    else expect(store.expireEntry(entry.id, entry.expiresAt)).toBeDefined();
    const peer = new LoopStore(path);
    expect(peer.get(entry.id)).toBeUndefined();
    expect(peer.list()).toEqual([]);
    expect(JSON.parse(readFileSync(path, "utf8")).loops).toEqual([]);
  });

  it("publishes an operator continuity matrix without new infrastructure promises", () => {
    const path = new URL("../docs/RUNTIME_CONTINUITY.md", import.meta.url);
    expect(existsSync(path), "the continuity matrix must be published").toBe(true);
    if (!existsSync(path)) return;
    const matrix = readFileSync(path, "utf8");
    for (const required of ["Pi is absent", "memory-only", "at-least-once", "pi-subagents", "no scheduler owner election", "unknown execution", "No removal history", "Proposed, unrun", "unless cancelled or retired by expiry"]) {
      expect(matrix).toContain(required);
    }
    expect(readFileSync(new URL("../README.md", import.meta.url), "utf8")).toContain("RUNTIME_CONTINUITY.md");
  });
});
