import { describe, expect, it, vi } from "vitest";
import { LoopStore } from "../src/store.js";
import { registerMonitorTools } from "../src/tools/monitor-tools.js";
import type { MonitorEntry } from "../src/types.js";
import { createMockPi } from "./helpers/mock-pi.js";

function makeMonitor(overrides: Partial<MonitorEntry> = {}): MonitorEntry {
  return {
    id: "1",
    command: "echo hi",
    timeout: 300000,
    status: "running",
    startedAt: Date.now(),
    outputLines: 0,
    outputBuffer: [],
    ...overrides,
  };
}

function setup(managerOverrides: Partial<{ list: () => MonitorEntry[]; stop: (id: string) => Promise<boolean> }> = {}) {
  const { pi, toolMap } = createMockPi();
  const store = new LoopStore();
  let nextId = 1;
  const manager = {
    list: managerOverrides.list ?? (() => []),
    create: vi.fn((command: string) => makeMonitor({ id: String(nextId++), command })),
    stop: managerOverrides.stop ?? vi.fn(async () => true),
  };
  const handleMonitorDoneLoop = vi.fn();
  registerMonitorTools({
    pi,
    getStore: () => store as any,
    getMonitorManager: () => manager as any,
    updateWidget: vi.fn(),
    handleMonitorDoneLoop,
  });
  const text = async (name: string, args: any) =>
    (await toolMap.get(name)!.execute!("t", args)).content[0].text as string;
  return { store, manager, handleMonitorDoneLoop, text, toolMap };
}

describe("MonitorCreate", () => {
  it("starts a monitor and reports the stream", async () => {
    const h = setup();
    const out = await h.text("MonitorCreate", { command: "npm test" });
    expect(out).toContain("Monitor #1 started");
    expect(out).toContain("Output stream: monitor:output");
    expect(h.manager.create).toHaveBeenCalledWith("npm test", undefined, undefined);
    expect(h.handleMonitorDoneLoop).not.toHaveBeenCalled();
    expect(h.toolMap.get("MonitorCreate")?.renderResult).toBeTypeOf("function");
  });

  it("creates a one-shot completion loop and registers it when onDone is set", async () => {
    const h = setup();
    const out = await h.text("MonitorCreate", { command: "npm test", onDone: "Report results" });
    expect(out).toContain("Completion wake loop #");
    expect(h.handleMonitorDoneLoop).toHaveBeenCalledTimes(1);
    // The done loop is a one-shot monitor:done event loop filtered by monitor id.
    const [doneLoop, monitorId] = h.handleMonitorDoneLoop.mock.calls[0];
    expect(monitorId).toBe("1");
    expect(doneLoop.recurring).toBe(false);
    expect(doneLoop.trigger).toMatchObject({ type: "event", source: "monitor:done" });
  });

  it("rejects creation when 25 monitors are already running", async () => {
    const running = Array.from({ length: 25 }, (_v, i) => makeMonitor({ id: String(i + 1) }));
    const h = setup({ list: () => running });
    const out = await h.text("MonitorCreate", { command: "x" });
    expect(out).toContain("Maximum of 25 running monitors");
    expect(h.manager.create).not.toHaveBeenCalled();
  });
});

describe("MonitorList", () => {
  it("reports no monitors when empty", async () => {
    const h = setup();
    expect(await h.text("MonitorList", {})).toBe("No monitors.");
  });

  it("lists monitors with status, exit code, and tail output", async () => {
    const completed = makeMonitor({
      id: "2",
      status: "completed",
      exitCode: 0,
      outputLines: 2,
      outputBuffer: ["line one", "line two"],
    });
    const h = setup({ list: () => [completed] });
    const out = await h.text("MonitorList", {});
    expect(out).toContain("#2 [completed]");
    expect(out).toContain("exit=0");
    expect(out).toContain("| line two");
  });
});

describe("MonitorStop", () => {
  it("stops a running monitor", async () => {
    const h = setup({ stop: vi.fn(async () => true) });
    expect(await h.text("MonitorStop", { monitorId: "1" })).toBe("Monitor #1 stopped");
  });

  it("reports when the monitor is not found or not running", async () => {
    const h = setup({ stop: vi.fn(async () => false) });
    expect(await h.text("MonitorStop", { monitorId: "9" })).toContain("not found or not running");
  });
});
