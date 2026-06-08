import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MonitorManager } from "../src/monitor-manager.js";

function createMockPi() {
  const handlers = new Map<string, Array<(...args: any[]) => void>>();
  return {
    events: {
      emit: vi.fn((event: string, data: any) => {
        const callbacks = handlers.get(event);
        if (callbacks) for (const cb of callbacks) cb(data);
      }),
      on: vi.fn((event: string, handler: (...args: any[]) => void) => {
        if (!handlers.has(event)) handlers.set(event, []);
        handlers.get(event)!.push(handler);
        return () => {
          const arr = handlers.get(event);
          if (arr) {
            const idx = arr.indexOf(handler);
            if (idx !== -1) arr.splice(idx, 1);
          }
        };
      }),
    },
  } as any;
}

describe("MonitorManager", () => {
  let manager: MonitorManager;
  let pi: ReturnType<typeof createMockPi>;

  beforeEach(() => {
    pi = createMockPi();
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
