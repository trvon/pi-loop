import { describe, expect, it, vi } from "vitest";
import { createMonitorOnDoneRuntime } from "../src/runtime/monitor-ondone-runtime.js";
import type { LoopEntry, MonitorEntry } from "../src/types.js";

const doneLoop = { id: "5", prompt: "report" } as LoopEntry;

function mockManager(config: { onCompleteReturns: boolean; status?: string }) {
  let captured: ((monitor?: MonitorEntry) => void) | undefined;
  return {
    onComplete: vi.fn((_id: string, cb: (monitor?: MonitorEntry) => void) => {
      captured = cb;
      return config.onCompleteReturns;
    }),
    get: vi.fn((id: string) => (config.status ? {
      id,
      command: "test",
      timeout: 0,
      status: config.status,
      startedAt: 0,
      outputLines: 0,
      outputBuffer: [],
    } as MonitorEntry : undefined)),
    fireCaptured: (monitor?: MonitorEntry) => captured?.(monitor),
  };
}

function setup(manager: ReturnType<typeof mockManager>) {
  const onLoopFire = vi.fn();
  const deleteLoop = vi.fn();
  const runtime = createMonitorOnDoneRuntime({
    monitorManager: manager as any,
    getLoop: (id: string) => (id === doneLoop.id ? doneLoop : undefined),
    deleteLoop,
    onLoopFire,
  });
  return { runtime, onLoopFire, deleteLoop };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe("monitor-ondone-runtime", () => {
  it("registers a completion callback on a running monitor and delivers once on completion", async () => {
    const manager = mockManager({ onCompleteReturns: true });
    const { runtime, onLoopFire, deleteLoop } = setup(manager);

    runtime.register(doneLoop, "3");
    expect(manager.onComplete).toHaveBeenCalledTimes(1);
    expect(onLoopFire).not.toHaveBeenCalled();

    // Simulate the monitor completing.
    manager.fireCaptured();
    await flush();

    expect(onLoopFire).toHaveBeenCalledTimes(1);
    expect(onLoopFire).toHaveBeenCalledWith(doneLoop);
    expect(deleteLoop).toHaveBeenCalledWith("5");
  });

  it("delivers immediately when the monitor is already completed", async () => {
    const manager = mockManager({ onCompleteReturns: false, status: "completed" });
    const { runtime, onLoopFire, deleteLoop } = setup(manager);

    runtime.register(doneLoop, "3");
    await flush();

    expect(onLoopFire).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "report\n\nMonitor #3 outcome: status=completed; exitCode=unavailable; outputLines=0.",
    }));
    expect(deleteLoop).toHaveBeenCalledWith("5");
  });

  it("delivers immediately when the monitor already errored", async () => {
    const manager = mockManager({ onCompleteReturns: false, status: "error" });
    const { runtime, onLoopFire, deleteLoop } = setup(manager);

    runtime.register(doneLoop, "3");
    await flush();

    expect(onLoopFire).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "report\n\nMonitor #3 outcome: status=error; exitCode=unavailable; outputLines=0.",
    }));
    expect(deleteLoop).toHaveBeenCalledWith("5");
  });

  it("includes the monitor outcome and output tail in the completion wake", async () => {
    const manager = mockManager({ onCompleteReturns: true });
    const { runtime, onLoopFire } = setup(manager);
    const monitor = {
      id: "3",
      status: "completed",
      exitCode: 0,
      outputLines: 2,
      outputBuffer: ["first result", "last result"],
    } as MonitorEntry;

    runtime.register(doneLoop, "3");
    manager.fireCaptured(monitor);
    await flush();

    expect(onLoopFire).toHaveBeenCalledWith(expect.objectContaining({
      prompt: [
        "report",
        "",
        "Monitor #3 outcome: status=completed; exitCode=0; outputLines=2.",
        "Output tail:",
        "  first result",
        "  last result",
      ].join("\n"),
    }));
  });

  it("expires the loop when the monitor already finished in a non-notifying state", async () => {
    const manager = mockManager({ onCompleteReturns: false, status: "stopped" });
    const { runtime, onLoopFire, deleteLoop } = setup(manager);

    runtime.register(doneLoop, "3");
    await flush();

    expect(onLoopFire).not.toHaveBeenCalled();
    expect(deleteLoop).toHaveBeenCalledWith("5");
  });

  it("does nothing extra when the monitor is gone entirely", async () => {
    const manager = mockManager({ onCompleteReturns: false });
    const { runtime, onLoopFire, deleteLoop } = setup(manager);

    runtime.register(doneLoop, "3");
    await flush();

    expect(onLoopFire).not.toHaveBeenCalled();
    expect(deleteLoop).not.toHaveBeenCalled();
  });
});
