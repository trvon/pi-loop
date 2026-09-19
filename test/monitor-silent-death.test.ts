import { initTheme } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MonitorManager } from "../src/monitor-manager.js";
import { createMonitorOnDoneRuntime } from "../src/runtime/monitor-ondone-runtime.js";
import { LoopStore } from "../src/store.js";
import { registerMonitorTools } from "../src/tools/monitor-tools.js";
import type { LoopEntry, MonitorEntry } from "../src/types.js";
import { createMockPi } from "./helpers/mock-pi.js";
import { createMockChildProcess, createSequentialSpawn } from "./helpers/mock-spawn.js";

// Regressions: each case is a way a monitor once ended without the agent or
// the operator learning why.

describe("monitor silent death — MonitorManager", () => {
  let pi: any;
  let manager: MonitorManager;

  beforeEach(() => {
    pi = createMockPi().pi;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps settling a monitor when one completion callback throws", () => {
    const child = createMockChildProcess({ exitCode: null });
    manager = new MonitorManager(pi, createSequentialSpawn(child));
    const entry = manager.create("sleep 30", "throwing callback", 0);
    const later = vi.fn();
    const terminal = vi.fn();
    manager.onComplete(entry.id, () => {
      throw new Error("store lock unavailable");
    });
    manager.onComplete(entry.id, later);
    manager.onTerminal(entry.id, terminal);
    const retention = vi.spyOn(global, "setTimeout");

    // A throw here would surface as an uncaughtException from the child's
    // 'close' listener in production.
    expect(() => child.emit("close", 1)).not.toThrow();

    expect(later).toHaveBeenCalledTimes(1);
    expect(terminal).toHaveBeenCalledTimes(1);
    expect(manager.getProcess(entry.id)?.terminalReady).toBe(true);
    expect(retention).toHaveBeenCalled();
  });

  it("records the signal when the child is killed from outside", () => {
    const child = createMockChildProcess({ exitCode: null });
    manager = new MonitorManager(pi, createSequentialSpawn(child));
    const entry = manager.create("sleep 30", "oom killed", 0);

    child.emit("close", null, "SIGKILL");

    const current = manager.get(entry.id) as MonitorEntry & { signal?: string };
    expect(current.status).toBe("error");
    expect(current.signal).toBe("SIGKILL");
    expect(pi.events.emit).toHaveBeenCalledWith("monitor:finished", expect.objectContaining({
      monitorId: entry.id,
      signal: "SIGKILL",
    }));
  });

  it("settles a monitor whose shell exited while a grandchild holds its pipes open", async () => {
    vi.useFakeTimers();
    const child = createMockChildProcess({ exitCode: null });
    manager = new MonitorManager(pi, createSequentialSpawn(child));
    const entry = manager.create("server & exit 1", "exit without close", 0);

    // Node emits 'exit' when the shell dies but withholds 'close' until every
    // inherited stdio handle closes; with timeout=0 nothing else ends the monitor.
    child.emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(manager.get(entry.id)?.status).not.toBe("running");
  });

  it("does not leave an unhandled rejection when the timeout stop fails", async () => {
    vi.useFakeTimers();
    const child = createMockChildProcess({ exitCode: null });
    manager = new MonitorManager(pi, createSequentialSpawn(child));
    manager.create("sleep 30", "timeout stop failure", 1000);
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    pi.events.emit.mockImplementation((name: string) => {
      if (name === "monitor:finished") throw new Error("event bus failure");
    });

    try {
      await vi.advanceTimersByTimeAsync(1000);
      vi.useRealTimers();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});

describe("monitor silent death — wake delivery", () => {
  const alertLoop = {
    id: "9",
    prompt: "Monitor #1 became stale",
    trigger: { type: "event", source: "monitor:timeout", filter: JSON.stringify({ monitorId: "1" }) },
  } as LoopEntry;

  function crashed(overrides: Partial<MonitorEntry> = {}): MonitorEntry {
    return {
      id: "1",
      command: "npm test",
      timeout: 300_000,
      status: "error",
      exitCode: 1,
      startedAt: 0,
      outputLines: 3,
      outputBuffer: [],
      ...overrides,
    };
  }

  it("wakes the agent when a monitor without onDone crashes", async () => {
    let terminal: ((monitor?: MonitorEntry) => void) | undefined;
    const onLoopFire = vi.fn();
    const runtime = createMonitorOnDoneRuntime({
      monitorManager: {
        onTerminal: (_id: string, cb: (monitor?: MonitorEntry) => void) => {
          terminal = cb;
          return true;
        },
        onComplete: () => false,
        get: () => crashed(),
      } as any,
      getLoop: (id) => (id === alertLoop.id ? alertLoop : undefined),
      deleteLoop: vi.fn(),
      expireLoop: () => false,
      onLoopFire,
      isContextCurrent: () => true,
      settleWorkflowMonitorWait: vi.fn(() => ({ kind: "stale" as const })) as any,
      rearmWorkflow: vi.fn(),
      wakeWorkflow: vi.fn(),
    });

    runtime.register(alertLoop, "1");
    terminal?.(crashed());
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(onLoopFire).toHaveBeenCalledTimes(1);
    expect(onLoopFire.mock.calls[0]![0].prompt).toContain("status=error");
  });

  describe("MonitorCreate", () => {
    beforeAll(() => initTheme("dark"));

    it("arranges a failure wake even when the inactivity timeout is disabled", async () => {
      const { pi: toolPi, toolMap } = createMockPi();
      const store = new LoopStore(undefined);
      const handleMonitorDoneLoop = vi.fn();
      registerMonitorTools({
        pi: toolPi,
        getStore: () => store as any,
        getMonitorManager: () => ({
          list: () => [],
          create: (command: string) => crashed({ command, timeout: 0, status: "running", exitCode: undefined }),
          stop: async () => true,
          updateProgress: () => undefined,
        }) as any,
        getTriggerSystem: () => ({ remove: vi.fn() }),
        getActor: () => ({ sessionId: "s", runtimeId: "r" }),
        updateWidget: vi.fn(),
        handleMonitorDoneLoop,
        handleWorkflowMonitorWait: vi.fn(),
      });

      await toolMap.get("MonitorCreate")!.execute!("t", { command: "tail -f app.log", timeout: 0 });

      expect(handleMonitorDoneLoop).toHaveBeenCalledTimes(1);
    });
  });
});
