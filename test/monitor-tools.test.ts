import { initTheme } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import { beforeAll, describe, expect, it, vi } from "vitest";
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

function setup(managerOverrides: Partial<{
  list: () => MonitorEntry[];
  stop: (id: string) => Promise<boolean>;
  updateProgress: (id: string, progress: any) => MonitorEntry | undefined;
}> = {}) {
  const { pi, toolMap } = createMockPi();
  const store = new LoopStore();
  let nextId = 1;
  const manager = {
    list: managerOverrides.list ?? (() => []),
    create: vi.fn((command: string) => makeMonitor({ id: String(nextId++), command })),
    stop: managerOverrides.stop ?? vi.fn(async () => true),
    updateProgress: managerOverrides.updateProgress ?? vi.fn((_id: string, progress: any) => makeMonitor({
      progress: { ...progress, source: "agent", updatedAt: Date.now() },
    })),
  };
  const handleMonitorDoneLoop = vi.fn();
  const triggerSystem = { remove: vi.fn() };
  const handleWorkflowMonitorWait = vi.fn();
  registerMonitorTools({
    pi,
    getStore: () => store as any,
    getMonitorManager: () => manager as any,
    getTriggerSystem: () => triggerSystem,
    updateWidget: vi.fn(),
    handleMonitorDoneLoop,
    handleWorkflowMonitorWait,
  });

  const result = async (name: string, args: any) => await toolMap.get(name)!.execute!("t", args);
  const text = async (name: string, args: any) => (await result(name, args)).content[0].text as string;
  return { store, manager, triggerSystem, handleMonitorDoneLoop, handleWorkflowMonitorWait, text, result, toolMap };
}

describe("MonitorCreate", () => {
  beforeAll(() => initTheme("dark"));
  it("starts a monitor and reports the stream", async () => {
    const h = setup();
    const out = await h.text("MonitorCreate", { command: "npm test" });
    expect(out).toContain("Monitor #1 started");
    expect(out).toContain("monitor:output is rate-limited");
    expect(out).toContain("Inactivity timeout: 300s");
    expect(h.manager.create).toHaveBeenCalledWith("npm test", undefined, undefined);
    expect(h.handleMonitorDoneLoop).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining("Monitor #1 became stale"),
      trigger: expect.objectContaining({ type: "event", source: "monitor:timeout" }),
    }), "1");
    expect(h.toolMap.get("MonitorCreate")?.renderShell).not.toBe("self");
    expect(h.toolMap.get("MonitorCreate")?.renderCall).toBeTypeOf("function");
    expect(h.toolMap.get("MonitorCreate")?.renderResult).toBeTypeOf("function");
  });

  it("rejects negative inactivity timeouts", () => {
    const h = setup();
    const schema = h.toolMap.get("MonitorCreate")?.parameters;

    expect(Check(schema as any, { command: "npm test", timeout: -1 })).toBe(false);
    expect(Check(schema as any, { command: "npm test", timeout: 0 })).toBe(true);
  });

  it("renders monitor lifecycle results as visible compact rows", async () => {
    const h = setup();
    const createResult = await h.result("MonitorCreate", { command: "npm test", description: "Run tests" });
    expect(createResult.details).toMatchObject({
      kind: "monitor",
      action: "create",
      tone: "success",
      summary: "Monitor #1 running · Run tests",
    });

    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as any;
    const call = (h.toolMap.get("MonitorCreate") as any).renderCall({ command: "npm test", description: "Run tests" }, theme);
    expect(call.render(80).join("\n")).toContain("Monitor start · Run tests");
    const rendered = (h.toolMap.get("MonitorCreate") as any).renderResult(
      createResult,
      { expanded: false, isPartial: false },
      theme,
    );
    expect(rendered.render(80).join("\n")).toContain("Monitor #1 running");
  });

  it("renders concise calls for list, progress, and stop actions", () => {
    const h = setup();
    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as any;
    const cases = [
      ["MonitorList", {}, "Monitor status"],
      ["MonitorUpdate", { monitorId: "4" }, "Monitor update · #4"],
      ["MonitorStop", { monitorId: "4" }, "Monitor stop · #4"],
    ] as const;

    for (const [name, args, expected] of cases) {
      const call = (h.toolMap.get(name) as any).renderCall(args, theme);
      expect(call.render(80).join("\n")).toContain(expected);
    }
  });

  it("keeps monitor failures visible in the transcript", async () => {
    const h = setup();
    const result = await h.result("MonitorCreate", { command: "npm test", workflowId: "1", onDone: "report" });
    expect(result.details).toMatchObject({
      kind: "monitor",
      action: "create",
      tone: "error",
      summary: "Choose workflowId or onDone",
    });
    expect(h.toolMap.get("MonitorCreate")?.renderShell).not.toBe("self");
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

  it("binds a monitor to an active workflow and suppresses its cadence", async () => {
    const h = setup();
    const workflow = h.store.create({ type: "dynamic" }, "Validate release", {
      recurring: true,
      workflow: {
        version: 1,
        initialState: "validate",
        states: {
          validate: { prompt: "Run validation.", on: { passed: "done" } },
          done: { prompt: "Report success.", terminal: "completed" },
        },
      },
    });

    const out = await h.text("MonitorCreate", {
      command: "npm test",
      workflowId: workflow.id,
    });

    expect(h.store.get(workflow.id)?.workflow?.waitingMonitor).toMatchObject({
      monitorId: "1",
      stateId: "validate",
      transitionSeq: 0,
    });
    expect(h.triggerSystem.remove).toHaveBeenCalledWith(workflow.id);
    expect(h.handleWorkflowMonitorWait).toHaveBeenCalledWith(h.store.get(workflow.id));
    expect(out).toContain(`Workflow #${workflow.id} is waiting on monitor #1 — no polling needed`);
  });

  it("rejects workflow ownership together with an onDone prompt", async () => {
    const h = setup();

    const out = await h.text("MonitorCreate", {
      command: "npm test",
      workflowId: "1",
      onDone: "report results",
    });

    expect(out).toContain("workflowId cannot be combined with onDone");
    expect(h.manager.create).not.toHaveBeenCalled();
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

  it("includes the output tail for a running monitor", async () => {
    const running = makeMonitor({
      outputLines: 1,
      outputBuffer: ["current experiment progress"],
    });
    const h = setup({ list: () => [running] });

    expect(await h.text("MonitorList", {})).toContain("| current experiment progress");
  });

  it("shows a percentage only when current and total are supplied", async () => {
    const h = setup({ list: () => [makeMonitor({
      progress: { current: 25, total: 100, message: "training", source: "jsonl", updatedAt: Date.now() },
    })] });
    expect(await h.text("MonitorList", {})).toContain("25% (25/100) · training");
  });

  it("shows a progress message without inferring a percentage", async () => {
    const h = setup({ list: () => [makeMonitor({
      progress: { message: "waiting for validation", source: "jsonl", updatedAt: Date.now() },
    })] });
    const out = await h.text("MonitorList", {});
    expect(out).toContain("waiting for validation");
    expect(out).not.toContain("%");
  });

  it("shows observed log velocity for active monitors", async () => {
    const h = setup({ list: () => [makeMonitor({
      lastOutputAt: Date.now(),
      outputRatePerMinute: 24,
    })] });
    expect(await h.text("MonitorList", {})).toContain("24 lines/min");
  });

  it("shows quiet time without claiming the monitor has failed", async () => {
    const h = setup({ list: () => [makeMonitor({
      startedAt: Date.now() - 120000,
      lastOutputAt: Date.now() - 120000,
      outputRatePerMinute: 24,
    })] });
    expect(await h.text("MonitorList", {})).toContain("quiet 2m");
  });

  it("shows quiet time for a monitor that has not produced output", async () => {
    const h = setup({ list: () => [makeMonitor({
      startedAt: Date.now() - 120000,
    })] });
    expect(await h.text("MonitorList", {})).toContain("quiet 2m");
  });

  it("treats recent structured progress as monitor activity", async () => {
    const h = setup({ list: () => [makeMonitor({
      startedAt: Date.now() - 120000,
      lastOutputAt: Date.now() - 120000,
      progress: { message: "still working", source: "agent", updatedAt: Date.now() },
    })] });
    expect(await h.text("MonitorList", {})).not.toContain("quiet");
  });

  it("uses authoritative activity for partial output", async () => {
    const h = setup({ list: () => [makeMonitor({
      startedAt: Date.now() - 120000,
      lastOutputAt: Date.now() - 120000,
      lastActivityAt: Date.now(),
    })] });
    expect(await h.text("MonitorList", {})).not.toContain("quiet");
  });
});

describe("MonitorUpdate", () => {
  it("updates an agent-provided progress message", async () => {
    const updateProgress = vi.fn((_id: string, progress: any) => makeMonitor({
      progress: { ...progress, source: "agent", updatedAt: Date.now() },
    }));
    const h = setup({ updateProgress });

    expect(await h.text("MonitorUpdate", { monitorId: "1", message: "waiting for worker" }))
      .toContain("waiting for worker");
    expect(updateProgress).toHaveBeenCalledWith("1", {
      current: undefined,
      total: undefined,
      message: "waiting for worker",
    });
  });

  it("requires at least one recognized progress field", () => {
    const h = setup();
    const schema = h.toolMap.get("MonitorUpdate")?.parameters;

    expect(Check(schema as any, { monitorId: "1" })).toBe(false);
    expect(Check(schema as any, { monitorId: "1", ignored: true })).toBe(false);
    expect(Check(schema as any, { monitorId: "1", message: "working" })).toBe(true);
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
