import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTaskProviderRuntime } from "../src/runtime/task-provider-runtime.js";
import { createMockPi } from "./helpers/mock-pi.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function setup(respondToTaskPing = false, isStaleExtensionContextError: (error: unknown) => boolean = () => false) {
  let sessionId = "session-a";
  let sessionGeneration = 0;
  const mock = createMockPi({ respondToTaskPing });
  const evaluateTaskBacklog = vi.fn(async () => ({ created: false, cleaned: 0 }));
  const onReady = vi.fn(async () => {});
  const runtime = createTaskProviderRuntime({
    pi: mock.pi,
    runtimeId: "runtime-a",
    resolveStorePath: () => undefined,
    getSessionId: () => sessionId,
    evaluateTaskBacklog,
    onReady,
    getSessionGeneration: () => sessionGeneration,
    updateWidget: vi.fn(),
    isStaleExtensionContextError,
  });
  return {
    ...mock,
    runtime,
    evaluateTaskBacklog,
    onReady,
    setSessionId: (next: string) => { sessionId = next; },
    setSessionGeneration: (next: number) => { sessionGeneration = next; },
  };
}

describe("task-provider-runtime", () => {
  it("registers native RPC immediately but delays colliding tools", async () => {
    const { pi, toolMap, emittedEvents, runtime, onReady } = setup();

    pi.events.emit("tasks:rpc:ping", { requestId: "early" });
    await Promise.resolve();
    expect(emittedEvents).toContainEqual(expect.objectContaining({
      name: "tasks:rpc:ping:reply:early",
    }));
    expect(toolMap.has("TaskCreate")).toBe(false);

    await vi.advanceTimersByTimeAsync(6_100);
    expect(toolMap.has("TaskCreate")).toBe(true);
    expect(runtime.isReady()).toBe(true);
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it("carries the detection generation into delayed readiness", async () => {
    const { onReady, setSessionGeneration } = setup();

    setSessionGeneration(1);
    await vi.advanceTimersByTimeAsync(6_100);

    expect(onReady).toHaveBeenCalledWith(0);
  });

  it("lets an external provider win without registering native tools", async () => {
    const { toolMap, runtime, onReady } = setup(true);
    await vi.advanceTimersByTimeAsync(6_100);

    expect(toolMap.has("TaskCreate")).toBe(false);
    expect(runtime.isReady()).toBe(true);
    expect(runtime.summary()).toEqual({ count: 0 });
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it("keeps native ownership when an external provider appears after native tools register", async () => {
    const { pi, toolMap, runtime } = setup();
    await vi.advanceTimersByTimeAsync(6_100);
    pi.events.on("tasks:rpc:ping", (request: { requestId: string }) => {
      pi.events.emit(`tasks:rpc:ping:reply:${request.requestId}`, {
        success: true,
        data: { version: 3, provider: "late-external" },
      });
    });

    pi.events.emit("tasks:ready", {});
    await vi.advanceTimersByTimeAsync(10);
    await toolMap.get("TaskCreate")!.execute!("create", { subject: "native", description: "owned here" });

    expect(runtime.summary()).toMatchObject({ count: 1, focusText: "next: native" });
  });

  it("rebinds native task tools when the active session changes", async () => {
    const { toolMap, setSessionId } = setup();
    await vi.advanceTimersByTimeAsync(6_100);
    const create = toolMap.get("TaskCreate")!;
    const list = toolMap.get("TaskList")!;
    await create.execute!("a", { subject: "session A", description: "A" });

    setSessionId("session-b");
    expect((await list.execute!("list-b", {})).content[0].text).toBe("No tasks.");
    await create.execute!("b", { subject: "session B", description: "B" });

    setSessionId("session-a");
    const inA = (await list.execute!("list-a", {})).content[0].text;
    expect(inA).toContain("session A");
    expect(inA).not.toContain("session B");
  });

  it("settles backlog state after completing a native task", async () => {
    const { toolMap, evaluateTaskBacklog } = setup();
    await vi.advanceTimersByTimeAsync(6_100);
    await toolMap.get("TaskCreate")!.execute!("create", { subject: "state task", description: "work" });
    evaluateTaskBacklog.mockClear();

    await toolMap.get("TaskUpdate")!.execute!("complete", { id: "1", status: "completed" });

    expect(evaluateTaskBacklog).toHaveBeenCalled();
  });

  it("cancels delayed fallback registration on session shutdown", async () => {
    const { extensionHandlers, toolMap } = setup();
    for (const handler of extensionHandlers.get("session_shutdown") ?? []) await handler(null, {});
    await vi.advanceTimersByTimeAsync(6_100);

    expect(toolMap.has("TaskCreate")).toBe(false);
  });

  it("registers native tools on demand before the fallback timer fires", async () => {
    const { pi, toolMap, commandMap, runtime, onReady } = setup();
    const registerTool = vi.spyOn(pi, "registerTool");
    expect(toolMap.has("TaskCreate")).toBe(false);

    expect(runtime.registerNativeTools("session_start")).toBe(true);

    expect(toolMap.has("TaskCreate")).toBe(true);
    expect(toolMap.has("TaskList")).toBe(true);
    expect(toolMap.has("TaskUpdate")).toBe(true);
    expect(toolMap.has("TaskDelete")).toBe(true);
    expect(commandMap.has("tasks")).toBe(true);
    expect(runtime.isReady()).toBe(true);
    await Promise.resolve();
    expect(onReady).toHaveBeenCalledTimes(1);

    const registrations = registerTool.mock.calls.length;
    await vi.advanceTimersByTimeAsync(6_100);
    expect(runtime.registerNativeTools("session_start")).toBe(true);
    expect(registerTool.mock.calls.length).toBe(registrations);
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it("does not register native tools on demand once an external provider answered", async () => {
    const { toolMap, commandMap, runtime } = setup(true);
    await Promise.resolve();

    expect(runtime.registerNativeTools("session_start")).toBe(false);

    expect(toolMap.has("TaskCreate")).toBe(false);
    expect(commandMap.has("tasks")).toBe(false);
    await vi.advanceTimersByTimeAsync(6_100);
    expect(toolMap.has("TaskCreate")).toBe(false);
    expect(runtime.isReady()).toBe(true);
  });

  it("swallows a stale extension context during on-demand registration", async () => {
    const staleError = new Error("This extension ctx is stale after session replacement or reload.");
    const { pi, toolMap, runtime, onReady } = setup(false, (error) => error === staleError);
    pi.registerCommand = vi.fn(() => {
      throw staleError;
    });

    expect(runtime.registerNativeTools("session_start")).toBe(false);

    expect(toolMap.has("TaskCreate")).toBe(false);
    expect(runtime.isReady()).toBe(false);
    await Promise.resolve();
    expect(onReady).not.toHaveBeenCalled();
  });
});
