import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MONITOR_RETENTION_MS, MonitorManager } from "../src/monitor-manager.js";
import { createMockPi } from "./helpers/mock-pi.js";
import { createMockChildProcess, createSequentialSpawn } from "./helpers/mock-spawn.js";

describe("MonitorManager", () => {
  let manager: MonitorManager;
  let pi: any;

  beforeEach(() => {
    pi = createMockPi().pi;
    manager = new MonitorManager(pi);
  });

  afterEach(async () => {
    for (const m of manager.list()) {
      if (m.status === "running") await manager.stop(m.id);
    }
    vi.restoreAllMocks();
  });

  it("creates a monitor and starts a process", () => {
    const entry = manager.create("echo hello world", "test monitor");
    expect(entry.id).toBe("1");
    expect(entry.status).toBe("running");
    expect(entry.command).toBe("echo hello world");
  });

  it("emits monitor:started once the monitor can be inspected", () => {
    const events: any[] = [];
    pi.events.on("monitor:started", (event: any) => events.push(event));

    const entry = manager.create("sleep 30", "started test");

    expect(events).toEqual([{
      monitorId: entry.id,
      command: "sleep 30",
      description: "started test",
      timeout: 300000,
      timestamp: expect.any(Number),
    }]);
    expect(manager.get(entry.id)).toBe(entry);
  });

  it("emits monitor:finished for a manually stopped monitor", async () => {
    const events: any[] = [];
    pi.events.on("monitor:finished", (event: any) => events.push(event));
    const entry = manager.create("sleep 30", "stopped test");

    await manager.stop(entry.id);

    expect(events).toEqual([{
      monitorId: entry.id,
      status: "stopped",
      reason: "manual",
      outputLines: 0,
    }]);
  });

  it("emits monitor:finished when a process cannot start", async () => {
    manager = new MonitorManager(
      pi,
      createSequentialSpawn(createMockChildProcess({ exitCode: null })),
    );
    const events: any[] = [];
    pi.events.on("monitor:finished", (event: any) => events.push(event));
    const entry = manager.create("missing-command", "spawn error");

    manager.getProcess(entry.id)?.proc.emit("error", new Error("spawn failed"));

    expect(events).toEqual([{
      monitorId: entry.id,
      status: "error",
      error: "spawn failed",
      outputLines: 0,
    }]);
  });
  it("gets a monitor by ID", () => {
    manager.create("echo test", "get test");
    const entry = manager.get("1");
    expect(entry).toBeDefined();
    expect(entry!.command).toBe("echo test");
  });

  it("returns undefined for non-existent monitor", () => {
    expect(manager.get("999")).toBeUndefined();
  });

  it("lists monitors sorted by ID", () => {
    manager.create("echo first", undefined, 10000);
    manager.create("echo second", undefined, 10000);

    const monitors = manager.list();
    expect(monitors.map(m => m.id)).toEqual(["1", "2"]);
  });

  it("swallows stale extension-context errors from delayed monitor output", () => {
    const child = createMockChildProcess({ exitCode: null });
    manager = new MonitorManager(pi, createSequentialSpawn(child));
    const entry = manager.create("sleep 30", "stale output test");
    pi.events.emit.mockImplementation(() => {
      throw new Error("This extension ctx is stale after session replacement or reload.");
    });

    expect(() => child.stdout?.emit("data", Buffer.from("late output\\n"))).not.toThrow();

    child.emit("close", 0);
    expect(manager.get(entry.id)?.status).toBe("completed");
  });

  it("stops monitors and ignores delayed child events during shutdown", async () => {
    vi.useFakeTimers();
    const child = createMockChildProcess({ exitCode: null });
    manager = new MonitorManager(pi, createSequentialSpawn(child));
    const onChange = vi.fn();
    const onComplete = vi.fn();
    manager.setOnChange(onChange);
    const entry = manager.create("sleep 30", "shutdown test");
    expect(manager.onComplete(entry.id, onComplete)).toBe(true);

    pi.events.emit.mockClear();
    pi.events.emit.mockImplementation(() => {
      throw new Error("This extension ctx is stale after session replacement or reload.");
    });

    const shutdown = manager.shutdown();
    await vi.advanceTimersByTimeAsync(5000);
    await shutdown;

    expect(manager.list()).toEqual([]);
    expect(onChange).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();

    expect(() => {
      child.stdout?.emit("data", Buffer.from("late stdout\\n"));
      child.stderr?.emit("data", Buffer.from("late stderr\\n"));
      child.emit("error", new Error("late child error"));
      child.emit("close", 0);
    }).not.toThrow();
    expect(pi.events.emit).not.toHaveBeenCalled();
    await manager.shutdown();
  });

  it("accepts new monitors after a session handoff", async () => {
    vi.useFakeTimers();
    const first = createMockChildProcess({ exitCode: null });
    let child = first;
    manager = new MonitorManager(pi, () => child);
    manager.create("sleep 30", "first session");

    const shutdown = manager.shutdown();
    await vi.advanceTimersByTimeAsync(5000);
    await shutdown;

    const second = createMockChildProcess({ exitCode: null });
    child = second;
    const callback = vi.fn();
    const next = manager.create("sleep 30", "next session");
    try {
      expect(manager.onComplete(next.id, callback)).toBe(true);

      second.emit("close", 0);
      expect(callback).toHaveBeenCalledOnce();
      expect(pi.events.emit).toHaveBeenCalledWith("monitor:started", expect.objectContaining({
        monitorId: next.id,
        command: "sleep 30",
      }));
    } finally {
      const stop = manager.stop(next.id);
      await vi.advanceTimersByTimeAsync(5000);
      await stop;
      vi.useRealTimers();
    }
  });

  it("emits monitor:output event with stdout lines", async () => {
    const entry = manager.create("echo 'test output'");

    await new Promise<void>((resolve) => {
      pi.events.on("monitor:output", (data: any) => {
        expect(data.monitorId).toBe(entry.id);
        expect(data.line).toContain("test output");
        resolve();
      });
    });
  });

  it("bounds buffered output and rate-limits high-volume progress events", () => {
    manager = new MonitorManager(
      pi,
      createSequentialSpawn(createMockChildProcess({ exitCode: null })),
    );
    const events: any[] = [];
    pi.events.on("monitor:output", (event: any) => events.push(event));
    const entry = manager.create("noisy experiment");
    const output = Array.from({ length: 1000 }, (_value, index) => `step ${index}`).join("\n");

    manager.getProcess(entry.id)?.proc.stdout?.emit("data", Buffer.from(`${output}\n`));

    const current = manager.get(entry.id)!;
    expect(current.outputLines).toBe(1000);
    expect(current.outputBuffer).toHaveLength(200);
    expect(current.outputBuffer[0]).toBe("step 800");
    expect(current.outputBuffer.at(-1)).toBe("step 999");
    expect(current.outputRatePerMinute).toBe(1000);
    expect(current.lastOutputAt).toEqual(expect.any(Number));
    expect(events).toEqual([expect.objectContaining({
      monitorId: entry.id,
      line: "step 999",
      outputLines: 1000,
      droppedLines: 999,
    })]);
    manager.getProcess(entry.id)?.proc.emit("close", 0);
  });

  it("extracts structured progress from JSON Lines without treating ordinary output as progress", () => {
    manager = new MonitorManager(
      pi,
      createSequentialSpawn(createMockChildProcess({ exitCode: null })),
    );
    const entry = manager.create("experiment");

    manager.getProcess(entry.id)?.proc.stdout?.emit("data", Buffer.from([
      "epoch 1 starting",
      '{"progress":{"current":25,"total":100,"message":"training epoch 1"}}',
      '{"progress":{"message":"waiting for validation"}}',
      '{"progress":{"current":"not a number"}}',
    ].join("\n") + "\n"));

    expect(manager.get(entry.id)?.progress).toMatchObject({
      current: 25,
      total: 100,
      message: "waiting for validation",
      source: "jsonl",
    });
    manager.getProcess(entry.id)?.proc.emit("close", 0);
  });

  it("allows agents to set an optional progress percentage or status message", () => {
    manager = new MonitorManager(
      pi,
      createSequentialSpawn(createMockChildProcess({ exitCode: null })),
    );
    const entry = manager.create("experiment");

    expect(manager.updateProgress(entry.id, { message: "waiting for remote worker" })?.progress).toMatchObject({
      message: "waiting for remote worker",
      source: "agent",
    });
    expect(manager.updateProgress(entry.id, { current: 3, total: 5, message: "epoch 3" })?.progress).toMatchObject({
      current: 3,
      total: 5,
      message: "epoch 3",
      source: "agent",
    });
    expect(manager.updateProgress("missing", { message: "nope" })).toBeUndefined();
    manager.getProcess(entry.id)?.proc.emit("close", 0);
  });

  it("frames split stream records before counting or parsing them", () => {
    manager = new MonitorManager(
      pi,
      createSequentialSpawn(createMockChildProcess({ exitCode: null })),
    );
    const entry = manager.create("experiment");
    const process = manager.getProcess(entry.id);
    if (!process?.proc.stdout) throw new Error("expected stdout");
    const stdout = process.proc.stdout;

    stdout.emit("data", Buffer.from('{"progress":{"current":'));
    expect(manager.get(entry.id)?.outputLines).toBe(0);
    expect(manager.get(entry.id)?.progress).toBeUndefined();

    stdout.emit("data", Buffer.from('1,"total":2,"message":"halfway"}}\n'));
    expect(manager.get(entry.id)?.outputLines).toBe(1);
    expect(manager.get(entry.id)?.outputBuffer).toEqual(['{"progress":{"current":1,"total":2,"message":"halfway"}}']);
    expect(manager.get(entry.id)?.progress).toMatchObject({ current: 1, total: 2, message: "halfway" });
    manager.getProcess(entry.id)?.proc.emit("close", 0);
  });

  it("retains an unterminated final output record on completion", () => {
    manager = new MonitorManager(
      pi,
      createSequentialSpawn(createMockChildProcess({ exitCode: null })),
    );
    const entry = manager.create("experiment");
    manager.getProcess(entry.id)?.proc.stdout?.emit("data", Buffer.from("final result"));

    manager.getProcess(entry.id)?.proc.emit("close", 0);

    expect(manager.get(entry.id)?.outputBuffer).toContain("final result");
  });

  it("coalesces JSONL progress widget updates to once per second", () => {
    vi.useFakeTimers();
    manager = new MonitorManager(
      pi,
      createSequentialSpawn(createMockChildProcess({ exitCode: null })),
    );
    const onChange = vi.fn();
    manager.setOnChange(onChange);
    const entry = manager.create("experiment");
    const process = manager.getProcess(entry.id);
    if (!process?.proc.stdout) throw new Error("expected stdout");
    const stdout = process.proc.stdout;

    stdout.emit("data", Buffer.from('{"progress":{"message":"one"}}\n'));
    stdout.emit("data", Buffer.from('{"progress":{"message":"two"}}\n'));
    expect(onChange).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000);
    expect(onChange).toHaveBeenCalledTimes(2);
    manager.getProcess(entry.id)?.proc.emit("close", 0);
    vi.useRealTimers();
  });

  it("rejects agent progress updates after a monitor completes", () => {
    manager = new MonitorManager(
      pi,
      createSequentialSpawn(createMockChildProcess({ exitCode: null })),
    );
    const entry = manager.create("experiment");
    manager.getProcess(entry.id)?.proc.emit("close", 0);

    expect(manager.updateProgress(entry.id, { message: "late update" })).toBeUndefined();
  });

  it("coalesces log-rate accounting into bounded one-second buckets", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T01:00:00.000Z"));
    manager = new MonitorManager(
      pi,
      createSequentialSpawn(createMockChildProcess({ exitCode: null })),
    );
    const entry = manager.create("noisy experiment");
    const process = manager.getProcess(entry.id);
    if (!process?.proc.stdout) throw new Error("expected stdout");
    const stdout = process.proc.stdout;

    for (let index = 0; index < 1000; index++) stdout.emit("data", Buffer.from("line\n"));

    expect(manager.getProcess(entry.id)?.outputBuckets).toHaveLength(1);
    expect(manager.get(entry.id)?.outputRatePerMinute).toBe(1000);
    manager.getProcess(entry.id)?.proc.emit("close", 0);
    vi.useRealTimers();
  });

  it("emits monitor:done on clean exit", async () => {
    manager.create("echo done", "done test");

    await new Promise<void>((resolve) => {
      pi.events.on("monitor:done", (data: any) => {
        expect(data.exitCode).toBe(0);
        resolve();
      });
    });
  });

  it("notifies terminal callbacks when a monitor is manually stopped", async () => {
    vi.useFakeTimers();
    const child = createMockChildProcess({ exitCode: null });
    manager = new MonitorManager(pi, createSequentialSpawn(child));
    const entry = manager.create("sleep 30", "terminal callback test");
    const callback = vi.fn();
    try {
      expect(manager.onTerminal(entry.id, callback)).toBe(true);

      const stop = manager.stop(entry.id);
      expect(callback).toHaveBeenCalledWith(expect.objectContaining({
        id: entry.id,
        status: "stopped",
        stopReason: "manual",
      }));
      await vi.advanceTimersByTimeAsync(5000);
      await stop;
    } finally {
      const stop = manager.stop(entry.id);
      await vi.advanceTimersByTimeAsync(5000);
      await stop;
      vi.useRealTimers();
    }
  });

  it("registers completion callbacks for running monitors and invokes them on success", async () => {
    const entry = manager.create("echo done", "callback test");
    const callback = vi.fn();

    expect(manager.onComplete(entry.id, callback)).toBe(true);
    expect(manager.getProcess(entry.id)?.completionCallbacks).toHaveLength(1);

    await new Promise<void>((resolve) => {
      pi.events.on("monitor:done", (data: any) => {
        if (data.monitorId === entry.id) resolve();
      });
    });

    expect(callback).toHaveBeenCalledTimes(1);
    expect(manager.getProcess(entry.id)?.completionCallbacks).toHaveLength(0);
  });

  it("invokes completion callbacks immediately for already errored monitors", async () => {
    manager = new MonitorManager(
      pi,
      createSequentialSpawn(createMockChildProcess({ exitCode: 3 })),
    );
    const entry = manager.create("exit 3", "fast failure");

    await new Promise<void>((resolve) => {
      pi.events.on("monitor:error", (data: any) => {
        if (data.monitorId === entry.id) resolve();
      });
    });
    expect(manager.get(entry.id)?.status).toBe("error");

    const callback = vi.fn();
    expect(manager.onComplete(entry.id, callback)).toBe(true);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("prunes completed monitors after the retention callback runs", async () => {
    const realSetTimeout = global.setTimeout;
    const retainedTimers: Array<() => void> = [];
    const timeoutSpy = vi.spyOn(global, "setTimeout").mockImplementation(((fn: TimerHandler, ms?: number, ...args: any[]) => {
      if (ms === MONITOR_RETENTION_MS) {
        retainedTimers.push(() => {
          if (typeof fn === "function") fn(...args);
        });
        return 1 as any;
      }
      return realSetTimeout(fn, ms, ...args);
    }) as typeof setTimeout);

    const entry = manager.create("echo done", "retention test");

    await new Promise<void>((resolve) => {
      pi.events.on("monitor:done", (data: any) => {
        if (data.monitorId === entry.id) resolve();
      });
    });

    expect(manager.get(entry.id)?.status).toBe("completed");
    expect(retainedTimers).toHaveLength(1);

    retainedTimers[0]();

    expect(manager.get(entry.id)).toBeUndefined();
    timeoutSpy.mockRestore();
  });

  it("unrefs the retention timer scheduled on stop (so pi -p can exit)", async () => {
    const realSetTimeout = global.setTimeout;
    const unref = vi.fn();
    const timeoutSpy = vi.spyOn(global, "setTimeout").mockImplementation(((fn: TimerHandler, ms?: number, ...args: any[]) => {
      if (ms === MONITOR_RETENTION_MS) return { unref } as any;
      return realSetTimeout(fn, ms, ...args);
    }) as typeof setTimeout);

    const entry = manager.create("sleep 30", "stop unref test", 300000);
    await manager.stop(entry.id);

    expect(unref).toHaveBeenCalledTimes(1);
    timeoutSpy.mockRestore();
  });

  it("unrefs the retention timer scheduled on completion (so pi -p can exit)", async () => {
    const realSetTimeout = global.setTimeout;
    const unref = vi.fn();
    const timeoutSpy = vi.spyOn(global, "setTimeout").mockImplementation(((fn: TimerHandler, ms?: number, ...args: any[]) => {
      if (ms === MONITOR_RETENTION_MS) return { unref } as any;
      return realSetTimeout(fn, ms, ...args);
    }) as typeof setTimeout);

    const entry = manager.create("echo done", "finish unref test");
    await new Promise<void>((resolve) => {
      pi.events.on("monitor:done", (data: any) => {
        if (data.monitorId === entry.id) resolve();
      });
    });

    expect(unref).toHaveBeenCalledTimes(1);
    timeoutSpy.mockRestore();
  });

  it("emits monitor:error on non-zero exit", async () => {
    manager.create("exit 1", "error test");

    await new Promise<void>((resolve) => {
      pi.events.on("monitor:error", (data: any) => {
        expect(data.exitCode).toBe(1);
        resolve();
      });
    });
  });

  it("stops a running monitor", async () => {
    const entry = manager.create("sleep 30", "long running", 300000);
    const stopped = await manager.stop(entry.id);

    expect(stopped).toBe(true);
    expect(manager.get(entry.id)!.status).toBe("stopped");
  });

  it("prunes stopped monitors after the retention window", async () => {
    const realSetTimeout = global.setTimeout;
    const retainedTimers: Array<() => void> = [];
    const timeoutSpy = vi.spyOn(global, "setTimeout").mockImplementation(((fn: TimerHandler, ms?: number, ...args: any[]) => {
      if (ms === MONITOR_RETENTION_MS) {
        retainedTimers.push(() => {
          if (typeof fn === "function") fn(...args);
        });
        return 1 as any;
      }
      return realSetTimeout(fn, ms, ...args);
    }) as typeof setTimeout);

    const entry = manager.create("sleep 30", "stop retention test", 300000);
    await manager.stop(entry.id);

    expect(manager.get(entry.id)!.status).toBe("stopped");
    // Stopped monitors must schedule the same retention prune as completed ones.
    expect(retainedTimers).toHaveLength(1);

    retainedTimers[0]();

    expect(manager.get(entry.id)).toBeUndefined();
    expect(manager.list()).toHaveLength(0);
    timeoutSpy.mockRestore();
  });

  it("prunes timed-out monitors after the retention window", async () => {
    const realSetTimeout = global.setTimeout;
    const retainedTimers: Array<() => void> = [];
    const timeoutSpy = vi.spyOn(global, "setTimeout").mockImplementation(((fn: TimerHandler, ms?: number, ...args: any[]) => {
      if (ms === MONITOR_RETENTION_MS) {
        retainedTimers.push(() => {
          if (typeof fn === "function") fn(...args);
        });
        return 1 as any;
      }
      return realSetTimeout(fn, ms, ...args);
    }) as typeof setTimeout);

    // Short timeout → MonitorManager auto-calls stop() once it elapses.
    manager.create("sleep 60", "timeout retention test", 50);
    await new Promise((r) => realSetTimeout(r, 150));

    expect(manager.get("1")!.status).toBe("stopped");
    expect(retainedTimers).toHaveLength(1);

    retainedTimers[0]();

    expect(manager.get("1")).toBeUndefined();
    timeoutSpy.mockRestore();
  });

  it("fires onChange on status transitions and prune, but not on output lines", async () => {
    const realSetTimeout = global.setTimeout;
    const retainedTimers: Array<() => void> = [];
    const timeoutSpy = vi.spyOn(global, "setTimeout").mockImplementation(((fn: TimerHandler, ms?: number, ...args: any[]) => {
      if (ms === MONITOR_RETENTION_MS) {
        retainedTimers.push(() => {
          if (typeof fn === "function") fn(...args);
        });
        return 1 as any;
      }
      return realSetTimeout(fn, ms, ...args);
    }) as typeof setTimeout);

    const onChange = vi.fn();
    manager.setOnChange(onChange);

    // Emits three output lines, then completes.
    const entry = manager.create("printf 'a\\nb\\nc\\n'", "onchange test", 300000);
    await new Promise<void>((resolve) => {
      pi.events.on("monitor:done", (data: any) => {
        if (data.monitorId === entry.id) resolve();
      });
    });

    // Output lines must not repaint; only the completion transition counts.
    expect(onChange).toHaveBeenCalledTimes(1);

    retainedTimers[0]();
    expect(onChange).toHaveBeenCalledTimes(2); // MONITOR_PRUNED
    expect(manager.get(entry.id)).toBeUndefined();
    timeoutSpy.mockRestore();
  });

  it("returns false when stopping non-existent monitor", async () => {
    expect(await manager.stop("999")).toBe(false);
  });

  it("returns false when stopping already stopped monitor", async () => {
    const entry = manager.create("sleep 5", undefined, 300000);
    await manager.stop(entry.id);
    expect(await manager.stop(entry.id)).toBe(false);
  });

  it("auto-stops monitors on timeout", async () => {
    vi.useFakeTimers();
    manager.create("sleep 60", "timeout test", 500);
    expect(manager.get("1")!.status).toBe("running");

    vi.advanceTimersByTime(600);
    expect(manager.get("1")!).toMatchObject({ status: "stopped", stopReason: "timeout" });
    vi.useRealTimers();
  });

  it("notifies completion callbacks when a monitor times out", async () => {
    vi.useFakeTimers();
    manager = new MonitorManager(
      pi,
      createSequentialSpawn(createMockChildProcess({ exitCode: null })),
    );
    const entry = manager.create("sleep 60", "timeout callback test", 500);
    const callback = vi.fn();
    const errors: any[] = [];
    pi.events.on("monitor:error", (event: any) => errors.push(event));

    expect(manager.onComplete(entry.id, callback)).toBe(true);
    await vi.advanceTimersByTimeAsync(5600);

    expect(manager.get(entry.id)?.status).toBe("stopped");
    expect(callback).toHaveBeenCalledTimes(1);
    expect(errors).toEqual([{
      monitorId: entry.id,
      error: "Timed out after 500ms",
      outputLines: 0,
    }]);
    vi.useRealTimers();
  });

  it("notifies completion callbacks before a timed-out process is reaped", async () => {
    vi.useFakeTimers();
    manager = new MonitorManager(
      pi,
      createSequentialSpawn(createMockChildProcess({ exitCode: null })),
    );
    const entry = manager.create("sleep 60", "timeout wake test", 500);
    const callback = vi.fn();

    expect(manager.onComplete(entry.id, callback)).toBe(true);
    await vi.advanceTimersByTimeAsync(500);

    expect(manager.get(entry.id)?.status).toBe("stopped");
    expect(callback).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("retains completed monitors for 15 minutes", async () => {
    vi.useFakeTimers();
    manager = new MonitorManager(
      pi,
      createSequentialSpawn(createMockChildProcess({ exitCode: 0 })),
    );
    const entry = manager.create("echo done", "retention test");
    await vi.runAllTicks();

    await vi.advanceTimersByTimeAsync(15 * 60 * 1000 - 1);
    expect(manager.get(entry.id)?.status).toBe("completed");

    await vi.advanceTimersByTimeAsync(1);
    expect(manager.get(entry.id)).toBeUndefined();
    vi.useRealTimers();
  });

  it("disables timeout when set to 0", async () => {
    manager.create("echo 'no timeout'", undefined, 0);
    await new Promise<void>((resolve) => {
      pi.events.on("monitor:done", () => resolve());
    });
    expect(manager.get("1")!.status).toBe("completed");
  });

  it("force-kills with SIGKILL when process ignores SIGTERM", async () => {
    vi.useFakeTimers();
    const entry = manager.create(
      "bash -c 'trap \"\" SIGTERM; while true; do sleep 1; done'",
      "sigterm ignorer",
      300000,
    );
    expect(manager.get(entry.id)!.status).toBe("running");

    const stopPromise = manager.stop(entry.id);
    vi.advanceTimersByTime(5100);
    const stopped = await stopPromise;

    expect(stopped).toBe(true);
    expect(manager.get(entry.id)!.status).toBe("stopped");
    vi.useRealTimers();
  });
});
