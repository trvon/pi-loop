import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MonitorManager } from "../src/monitor-manager.js";
import { createMockPi } from "./helpers/mock-pi.js";

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

  it("emits monitor:done on clean exit", async () => {
    manager.create("echo done", "done test");

    await new Promise<void>((resolve) => {
      pi.events.on("monitor:done", (data: any) => {
        expect(data.exitCode).toBe(0);
        resolve();
      });
    });
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

  it("prunes completed monitors after the retention callback runs", async () => {
    const realSetTimeout = global.setTimeout;
    const retainedTimers: Array<() => void> = [];
    const timeoutSpy = vi.spyOn(global, "setTimeout").mockImplementation(((fn: TimerHandler, ms?: number, ...args: any[]) => {
      if (ms === 30000) {
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
      if (ms === 30000) {
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
      if (ms === 30000) {
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
      if (ms === 30000) {
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
    expect(manager.get("1")!.status).toBe("stopped");
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
