import { afterEach, describe, expect, it } from "vitest";
import { createNativeSession } from "../benchmarks/native-session.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  const results = await Promise.allSettled(cleanups.splice(0).reverse().map(cleanup => cleanup()));
  const errors = results.filter(result => result.status === "rejected").map(result => result.reason);
  if (errors.length) throw new AggregateError(errors, "Native fixture cleanup failed");
});

async function createHarness(options: Parameters<typeof createNativeSession>[0] = {}) {
  const harness = await createNativeSession(options);
  cleanups.push(harness.close);
  return harness;
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

function scriptValue(result: { isError: boolean; content: Array<{ type: string; text?: string }> }): unknown {
  expect(result.isError, resultText(result)).toBe(false);
  const parts = result.content.filter((part) => part.type === "text");
  expect(parts[0]?.text).toContain("Script completed");
  return JSON.parse(parts.slice(1).map((part) => part.text).join("\n"));
}

describe("native Pi code-mode conformance", () => {
  it.each([false, true])("keeps direct tools available with absent/inactive codemode (registered=%s)", async (registered) => {
    const harness = await createHarness(registered ? { mode: "only", inactive: true } : {});
    expect(harness.session.getAllTools().some((tool) => tool.name === "codemode")).toBe(registered);
    expect(harness.session.getActiveToolNames()).not.toContain("codemode");
    const result = await harness.call("TaskList", {});
    expect(resultText(result)).toBe("No tasks.");
    expect(harness.requests[0]?.map((tool) => tool.name)).toEqual(expect.arrayContaining(["TaskCreate", "TaskClaim", "LoopList"]));
    expect(harness.requests[0]?.some((tool) => tool.name === "codemode")).toBe(false);
  });

  it.each(["on", "only"] as const)("runs direct pi-loop tools through native scripts in %s mode", async (mode) => {
    const harness = await createHarness({ mode });
    const active = harness.session.getActiveToolNames();
    expect(active).toEqual(expect.arrayContaining(["codemode", "LoopList", "TaskCreate", "TaskClaim"]));
    const loopTools = harness.session.getAllTools().filter((tool) => /^(Loop|Task|Workflow|Monitor|Orchestration)/.test(tool.name));
    expect(loopTools.length).toBeGreaterThan(0);
    expect(loopTools.every((tool) => tool.exposure === "direct")).toBe(true);
    const result = await harness.script("return { type: typeof await tools.TaskList({}), text: await tools.TaskList({}) };");
    expect(scriptValue(result)).toEqual({ type: "string", text: "No tasks." });
    const declared = harness.requests[0]?.map((tool) => tool.name);
    expect(declared).toContain("codemode");
    if (mode === "only") {
      for (const tool of loopTools) expect(declared).not.toContain(tool.name);
    } else {
      expect(declared).toEqual(expect.arrayContaining(loopTools.map((tool) => tool.name)));
      expect(harness.requests[0]?.find((tool) => tool.name === "TaskList")?.description).toContain("Codemode:");
    }
    expect(harness.session.getActiveToolNames()).toEqual(active);
    expect(harness.calls).toEqual(["codemode", "TaskList", "TaskList"]);
  });

  it.each(["on", "only"] as const)("creates, claims, and completes a task through scripts in %s mode", async (mode) => {
    const harness = await createHarness({ mode });
    const result = await harness.script(`
      const created = await tools.TaskCreate({ subject: "Conformance task", description: "Verify native claim ownership." });
      const id = created.match(/Task #([^ ]+) created/)[1];
      const before = await tools.TaskGet({ id });
      const claimed = await tools.TaskClaim({ id });
      const unclaimed = await tools.TaskUpdate({ id, status: "completed" });
      const during = await tools.TaskGet({ id });
      const claimId = claimed.match(/claimId: ([^\\n]+)/)[1];
      await tools.TaskUpdate({ id, status: "completed", claimId });
      return { unclaimed, before, during, after: await tools.TaskGet({ id }), loops: await tools.LoopList({}) };
    `);
    const value = scriptValue(result) as Record<string, string>;
    expect(value.unclaimed).toContain("rejected");
    expect(value.before).toContain("[pending] Conformance task");
    expect(value.during).toContain("[in_progress] Conformance task");
    expect(value.after).toContain("[completed] Conformance task");
    expect(value.loops).toBe("No loops configured. Use LoopCreate to set up a schedule.");
    expect(harness.requests[0]?.find((tool) => tool.name === "TaskCreate") !== undefined).toBe(mode === "on");
    expect(harness.calls).toEqual(["codemode", "TaskCreate", "TaskGet", "TaskClaim", "TaskUpdate", "TaskGet", "TaskUpdate", "TaskGet", "LoopList"]);
  });

  it("retains ownership guidance in inline catalogs and zero-budget discovery without mutations", async () => {
    for (const inlineBudget of [100000, 0]) {
      const harness = await createHarness({ mode: "only", inlineBudget });
      const active = harness.session.getActiveToolNames();
      const result = await harness.script(`
        return {
          workflow: await describeTool("WorkflowCreate"),
          task: await describeTool("TaskCreate"),
          transition: await describeTool("WorkflowTransition"),
          names: ALL_TOOLS.map(t => t.name),
          loops: await tools.LoopList({}),
          tasks: await tools.TaskList({}),
          monitors: await tools.MonitorList({})
        };
      `);
      const value = scriptValue(result) as Record<string, string | string[]>;
      expect(value.workflow).toContain("ordered phases, conditional outcomes, rework, or durable handoff");
      expect(value.task).toContain("independently completable backlog items");
      expect(value.transition).toContain("claimId is invalid");
      expect(value.names).toEqual(expect.arrayContaining(["WorkflowClaim", "TaskClaim", "LoopUpdate", "MonitorStop"]));
      expect(value.tasks).toBe("No tasks.");
      expect(value.monitors).toBe("No monitors.");
      expect(value.loops).toBe("No loops configured. Use LoopCreate to set up a schedule.");
      const catalog = harness.requests[0]?.find((tool) => tool.name === "codemode")?.description;
      if (inlineBudget === 0) {
        expect(catalog).not.toContain("### `WorkflowCreate`");
        expect(catalog).not.toContain("ordered phases, conditional outcomes, rework, or durable handoff");
      } else {
        expect(catalog).toContain("### `WorkflowCreate`");
        expect(catalog).toContain("ordered phases, conditional outcomes, rework, or durable handoff");
      }
      expect(harness.session.getActiveToolNames()).toEqual(active);
      expect(harness.calls).toEqual(["codemode", "LoopList", "TaskList", "MonitorList"]);
    }
  });

  it("does not make an inactive direct tool callable or discoverable", async () => {
    const harness = await createHarness({ mode: "only" });
    harness.session.setActiveToolsByName(harness.session.getActiveToolNames().filter((name) => name !== "TaskCreate"));
    expect(harness.session.getCallableToolNames()).not.toContain("TaskCreate");
    const result = await harness.script(`
      const attempt = await Promise.allSettled([Promise.resolve().then(() => tools.TaskCreate({ subject: "Must not exist", description: "Inactive" }))]);
      return { listed: ALL_TOOLS.some(t => t.name === "TaskCreate"), described: (await describeTool("TaskCreate")) !== undefined,
        status: attempt[0].status, tasks: await tools.TaskList({}) };
    `);
    expect(scriptValue(result)).toEqual({ listed: false, described: false, status: "rejected", tasks: "No tasks." });
    expect(harness.calls).not.toContain("TaskCreate");
  });

  it("preserves nested schema validation, permission denial, and fulfilled business rejections", async () => {
    const harness = await createHarness({ mode: "only", block: "TaskCreate" });
    const result = await harness.script(`
      const blocked = await Promise.allSettled([tools.TaskCreate({ subject: "Denied", description: "Must not exist" })]);
      const invalid = await Promise.allSettled([tools.LoopUpdate({ status: "continue" })]);
      const missing = await Promise.allSettled([tools.LoopUpdate({ id: "missing", status: "continue" })]);
      return { blocked: blocked[0].status, denied: String(blocked[0].reason), invalid: invalid[0].status,
        missing: missing[0].status, text: missing[0].value, tasks: await tools.TaskList({}), loops: await tools.LoopList({}) };
    `);
    expect(scriptValue(result)).toEqual({
      blocked: "rejected", denied: expect.stringContaining("Fixture permission denial"), invalid: "rejected",
      missing: "fulfilled", text: "Loop #missing not found", tasks: "No tasks.", loops: "No loops configured. Use LoopCreate to set up a schedule.",
    });
  });
});
