import { access } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNativeSession } from "../benchmarks/native-session.ts";

const sessions = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
});
async function fixture(options = {}) {
  const session = await createNativeSession(options);
  sessions.push(session);
  return session;
}

describe("native routing evidence boundary", () => {
  it("retains a successful nested creation when the script omits its output and then fails", async () => {
    const session = await fixture({ mode: "only", inlineBudget: 0 });
    const outer = await session.script('await tools.TaskCreate({subject:"Observed", description:"Independent fixture"}); throw new Error("outer failed after creation");');
    expect(outer.isError).toBe(true);
    const evidence = session.observations?.snapshot();
    expect(evidence).toMatchObject({ complete: true, agentRuns: 1 });
    const creation = evidence.calls.find(call => call.name === "TaskCreate");
    expect(creation).toMatchObject({ args: { subject: "Observed" }, isError: false, agentRun: 1 });
    expect(creation.parentToolCallId).toBeTruthy();
    expect(evidence.calls.find(call => call.toolCallId === creation.parentToolCallId)).toMatchObject({ name: "codemode", isError: true });
  });

  it("pairs schema rejection, permission denial and fulfilled business rejection even when scripts catch or omit them", async () => {
    const session = await fixture({ mode: "only", block: "TaskCreate" });
    await session.script(`
      await Promise.allSettled([
        tools.TaskCreate({subject:"Denied", description:"Must not exist"}),
        tools.LoopUpdate({status:"continue"})
      ]);
      await tools.LoopUpdate({id:"missing",status:"continue"});
      return "No nested results disclosed";
    `);
    const evidence = session.observations?.snapshot();
    expect(evidence).toMatchObject({ complete: true });
    const nested = evidence.calls.filter(call => call.parentToolCallId);
    expect(new Set(nested.map(call => call.toolCallId)).size).toBe(3);
    expect(nested.find(call => call.name === "TaskCreate")).toMatchObject({ isError: true });
    expect(nested.filter(call => call.name === "LoopUpdate").map(call => call.isError)).toEqual([true, false]);
    expect(JSON.stringify(nested)).toContain("Fixture permission denial");
    expect(JSON.stringify(nested)).toContain("Loop #missing not found");
    expect(session.calls.filter(name => name === "LoopUpdate")).toHaveLength(1);
  });

  it("keeps inventory active but gates non-controller writes in the model-evaluation fixture", async () => {
    const session = await fixture({ mode: "only", allowTools: ["codemode", "TaskCreate", "WorkflowCreate", "LoopCreate"] });
    expect(session.session.getCallableToolNames()).toContain("write");
    const active = session.session.getActiveToolNames();
    await session.script('await Promise.allSettled([tools.write({path:"must-not-exist.txt",content:"Must not be written"})]); return "caught";');
    expect(session.observations.snapshot().calls.find(call => call.name === "write")).toMatchObject({ isError: true });
    await expect(access(join(session.workspace, "must-not-exist.txt"))).rejects.toThrow();
    expect(session.session.getActiveToolNames()).toEqual(active);
  });

  it("observes distinct direct calls with the same result contract", async () => {
    const session = await fixture();
    await session.callMany([
      { name: "TaskCreate", args: { subject: "One", description: "Independent first item" } },
      { name: "TaskCreate", args: { subject: "Two", description: "Independent second item" } },
    ]);
    const evidence = session.observations?.snapshot();
    expect(evidence).toMatchObject({ complete: true });
    expect(evidence.calls).toHaveLength(2);
    expect(new Set(evidence.calls.map(call => call.toolCallId)).size).toBe(2);
    for (const call of evidence.calls) {
      expect(call).toMatchObject({ name: "TaskCreate", isError: false });
      expect(call.parentToolCallId).toBeUndefined();
      expect(call.result.content.length).toBeGreaterThan(0);
    }
  });
});
