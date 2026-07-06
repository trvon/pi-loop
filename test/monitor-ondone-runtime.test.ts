import { describe, expect, it, vi } from "vitest";
import { createMonitorOnDoneRuntime } from "../src/runtime/monitor-ondone-runtime.js";
import type { LoopEntry } from "../src/types.js";

const doneLoop = { id: "5", prompt: "report" } as LoopEntry;

function mockManager(config: { onCompleteReturns: boolean; status?: string }) {
  let captured: (() => void) | undefined;
  return {
    onComplete: vi.fn((_id: string, cb: () => void) => {
      captured = cb;
      return config.onCompleteReturns;
    }),
    get: vi.fn((id: string) => (config.status ? { id, status: config.status } : undefined)),
    fireCaptured: () => captured?.(),
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

    expect(onLoopFire).toHaveBeenCalledWith(doneLoop);
    expect(deleteLoop).toHaveBeenCalledWith("5");
  });

  it("delivers immediately when the monitor already errored", async () => {
    const manager = mockManager({ onCompleteReturns: false, status: "error" });
    const { runtime, onLoopFire, deleteLoop } = setup(manager);

    runtime.register(doneLoop, "3");
    await flush();

    expect(onLoopFire).toHaveBeenCalledWith(doneLoop);
    expect(deleteLoop).toHaveBeenCalledWith("5");
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
