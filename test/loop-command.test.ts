import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerLoopCommand } from "../src/commands/loop-command.js";
import { LoopStore } from "../src/store.js";
import { createCtx, createMockPi } from "./helpers/mock-pi.js";

function setup() {
  const { pi, commandMap } = createMockPi();
  const store = new LoopStore(); // memory mode, no file I/O
  const triggerSystem = { add: vi.fn(), remove: vi.fn() };
  const updateWidget = vi.fn();
  registerLoopCommand({
    pi,
    getStore: () => store as any,
    getTriggerSystem: () => triggerSystem as any,
    updateWidget,
  });
  const command = commandMap.get("loop")!;
  return { store, triggerSystem, updateWidget, command };
}

describe("registerLoopCommand", () => {
  let h: ReturnType<typeof setup>;
  beforeEach(() => {
    h = setup();
  });

  it("registers a loop command with a description", () => {
    expect(h.command).toBeDefined();
    expect(h.command.description).toContain("dynamic goal loop");
  });

  it("creates a cron loop from an interval + prompt argument string", async () => {
    const ctx = createCtx();
    await h.command.handler!("5m check the deploy", ctx);

    expect(h.store.list()).toHaveLength(1);
    const entry = h.store.get("1");
    expect(entry?.prompt).toBe("check the deploy");
    expect(entry?.trigger.type).toBe("cron");
    expect(entry?.recurring).toBe(true);
    expect(h.triggerSystem.add).toHaveBeenCalledTimes(1);
    expect(h.updateWidget).toHaveBeenCalledTimes(1);
    expect(ctx.notifications).toHaveLength(1);
    expect(ctx.notifications[0].message).toContain("Loop #1 created");
    expect(ctx.notifications[0].level).toBe("info");
  });

  it("warns when an interval is given without a prompt", async () => {
    const ctx = createCtx();
    await h.command.handler!("5m", ctx);

    expect(h.store.list()).toHaveLength(0);
    expect(h.triggerSystem.add).not.toHaveBeenCalled();
    expect(ctx.notifications).toHaveLength(1);
    expect(ctx.notifications[0].level).toBe("warning");
    expect(ctx.notifications[0].message).toContain("Provide a prompt after the interval");
  });

  it("creates a cron loop from a full cron expression + prompt", async () => {
    const ctx = createCtx();
    await h.command.handler!("*/15 * * * * check metrics", ctx);

    expect(h.store.list()).toHaveLength(1);
    expect(h.store.get("1")?.trigger).toEqual({ type: "cron", schedule: "*/15 * * * *" });
    expect(h.store.get("1")?.prompt).toBe("check metrics");
    expect(h.triggerSystem.add).toHaveBeenCalledTimes(1);
  });

  it("no-args invocation opens the Loop menu and creates nothing without a selection", async () => {
    const ui = {
      select: vi.fn(async () => undefined),
      input: vi.fn(async () => undefined),
      notify: vi.fn(),
    };
    const ctx = { ui } as any;

    await h.command.handler!("", ctx);

    expect(ui.select).toHaveBeenCalledWith("Loop", [
      "Create scheduled loop",
      "Create event-triggered loop",
      "View loops",
      "Settings",
    ]);
    expect(h.store.list()).toHaveLength(0);
  });

  it("no-args invocation with 'Settings' reports active/total loop counts", async () => {
    const ui = {
      select: vi.fn(async () => "Settings"),
      input: vi.fn(async () => undefined),
      notify: vi.fn(),
    };
    const ctx = { ui } as any;

    await h.command.handler!("", ctx);

    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("active loops (max 25)"), "info");
  });

  it("no-args invocation with 'View loops' reports no loops configured when empty", async () => {
    const ui = {
      select: vi.fn(async (title: string) => (title === "Loop" ? "View loops" : undefined)),
      input: vi.fn(async () => undefined),
      notify: vi.fn(),
    };
    const ctx = { ui } as any;

    await h.command.handler!("", ctx);

    expect(ui.select).toHaveBeenCalledWith("No loops configured", ["< Back"]);
  });

  it("no-args invocation with 'Create scheduled loop' prompts for prompt + interval and creates a loop", async () => {
    const ui = {
      select: vi.fn(async () => "Create scheduled loop"),
      input: vi.fn()
        .mockResolvedValueOnce("watch the build") // prompt
        .mockResolvedValueOnce("10m"), // interval
      notify: vi.fn(),
    };
    const ctx = { ui } as any;

    await h.command.handler!("", ctx);

    expect(h.store.list()).toHaveLength(1);
    expect(h.store.get("1")?.prompt).toBe("watch the build");
    expect(h.store.get("1")?.trigger.type).toBe("cron");
    expect(h.triggerSystem.add).toHaveBeenCalledTimes(1);
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("Loop #1 created"), "info");
  });

  it("edge: an unparseable interval typed interactively surfaces a notify error and creates nothing", async () => {
    const ui = {
      select: vi.fn(async () => "Create scheduled loop"),
      input: vi.fn()
        .mockResolvedValueOnce("watch the build")
        .mockResolvedValueOnce("not-an-interval"),
      notify: vi.fn(),
    };
    const ctx = { ui } as any;

    await h.command.handler!("", ctx);

    expect(h.store.list()).toHaveLength(0);
    expect(h.triggerSystem.add).not.toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("Cannot parse interval"), "error");
  });

  it("no-args invocation with 'Create event-triggered loop' creates a non-recurring event loop", async () => {
    const ui = {
      select: vi.fn(async () => "Create event-triggered loop"),
      input: vi.fn()
        .mockResolvedValueOnce("react to tool calls") // prompt
        .mockResolvedValueOnce("tool_execution_start"), // event source
      notify: vi.fn(),
    };
    const ctx = { ui } as any;

    await h.command.handler!("", ctx);

    expect(h.store.list()).toHaveLength(1);
    expect(h.store.get("1")?.trigger).toEqual({ type: "event", source: "tool_execution_start" });
    expect(h.triggerSystem.add).toHaveBeenCalledTimes(1);
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("Event loop #1 created"), "info");
  });

  it("free-text input defaults to a dynamic goal loop without prompting for mode", async () => {
    const ctx = createCtx();

    await h.command.handler!("finish the monitor wake fix", ctx);

    expect(h.store.list()).toHaveLength(1);
    expect(h.store.get("1")?.trigger).toEqual({ type: "dynamic" });
    expect(h.store.get("1")?.prompt).toBe("finish the monitor wake fix");
    expect(h.store.get("1")?.recurring).toBe(true);
    expect(h.store.get("1")?.maxFires).toBe(20);
    expect(h.store.get("1")?.dynamic).toMatchObject({
      goal: "finish the monitor wake fix",
      iteration: 0,
    });
    expect(h.store.get("1")?.dynamic?.nextWakeAt).toBeUndefined();
    expect(h.triggerSystem.add).toHaveBeenCalledTimes(1);
    expect(ctx.notifications[0].message).toContain("Dynamic loop #1 created");
  });

  it("explicit event syntax creates an event loop without mode selection", async () => {
    const ctx = createCtx();

    await h.command.handler!("event tasks:created process new tasks", ctx);

    expect(h.store.list()).toHaveLength(1);
    expect(h.store.get("1")?.trigger).toEqual({ type: "event", source: "tasks:created" });
    expect(h.store.get("1")?.prompt).toBe("process new tasks");
    expect(h.triggerSystem.add).toHaveBeenCalledTimes(1);
  });

  it("no-args 'View loops' -> select entry -> Delete removes the loop and its trigger", async () => {
    await h.command.handler!("5m check the deploy", createCtx());
    expect(h.store.list()).toHaveLength(1);

    const ui = {
      select: vi.fn(async (title: string) => {
        if (title === "Loop") return "View loops";
        if (title === "Loops") {
          return h.store.get("1")
            ? "* #1 [active] check the deploy (cron: */5 * * * *)"
            : "< Back";
        }
        if (title.startsWith("#1")) return "x Delete";
        return "< Back";
      }),
      input: vi.fn(),
      notify: vi.fn(),
    };
    const ctx = { ui } as any;

    await h.command.handler!("", ctx);

    expect(h.store.get("1")).toBeUndefined();
    expect(h.triggerSystem.remove).toHaveBeenCalledWith("1");
    expect(ui.notify).toHaveBeenCalledWith("Loop #1 deleted", "info");
  });

  it("no-args 'View loops' -> select entry -> Pause pauses without deleting", async () => {
    await h.command.handler!("5m check the deploy", createCtx());

    const ui = {
      select: vi.fn(async (title: string) => {
        if (title === "Loop") return "View loops";
        if (title === "Loops") {
          return h.store.get("1")?.status === "paused"
            ? "< Back"
            : "* #1 [active] check the deploy (cron: */5 * * * *)";
        }
        if (title.startsWith("#1")) return "- Pause";
        return "< Back";
      }),
      input: vi.fn(),
      notify: vi.fn(),
    };
    const ctx = { ui } as any;

    await h.command.handler!("", ctx);

    expect(h.store.get("1")?.status).toBe("paused");
    expect(h.triggerSystem.remove).toHaveBeenCalledWith("1");
    expect(ui.notify).toHaveBeenCalledWith("Loop #1 paused", "info");
  });
});
