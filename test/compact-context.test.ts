import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import { createNativeSession } from "../benchmarks/native-session.js";
import { COMPACT_GUIDE } from "../src/tools/tool-context.js";

describe("opt-in compact context", () => {
  it("keeps the default surface and adds read-only contract lookup only when opted in", async () => {
    const full = await createNativeSession();
    const compact = await createNativeSession({ contextProfile: "compact" });
    try {
      expect(full.session.getAllTools().some(tool => tool.name === "LoopHelp")).toBe(false);
      expect(full.session.getAllTools().some(tool => tool.name === "WorkflowCreate")).toBe(true);
      expect(compact.session.getAllTools().some(tool => tool.name === "LoopHelp")).toBe(true);
      const result = await compact.call("LoopHelp", { tool: "TaskCreate" });
      expect(result.isError).not.toBe(true);
      const text = result.content.find(part => part.type === "text");
      expect(text?.type).toBe("text");
      if (text?.type !== "text") throw new Error("Missing help");
      const contract = JSON.parse(text.text);
      expect(contract.name).toBe("TaskCreate");
      expect(contract.parameters.properties.description.description).toBe("Detailed description of what needs to be done");
      expect(contract.promptGuidelines.join("\n")).toContain("WorkflowCreate");
    } finally {
      await compact.close();
      await full.close();
    }
  });

  it("reduces direct request bytes including the help declaration and retained guide", async () => {
    let fullBytes = 0;
    let compactBytes = 0;
    const full = await createNativeSession({ onRequest: context => { fullBytes = Buffer.byteLength(JSON.stringify(context)); } });
    const compact = await createNativeSession({ contextProfile: "compact", onRequest: context => { compactBytes = Buffer.byteLength(JSON.stringify(context)); } });
    try {
      await full.prompt("Inspect the controller surface without running work.");
      await compact.prompt("Inspect the controller surface without running work.");
      expect(fullBytes).toBeGreaterThan(20000);
      expect(compactBytes).toBeLessThan(fullBytes * 0.75);
    } finally {
      await compact.close();
      await full.close();
    }
  });

  it("recovers all original contracts and preserves validation for all existing tool schemas", async () => {
    const full = await createNativeSession();
    const compact = await createNativeSession({ contextProfile: "compact" });
    const valid: Record<string, Record<string, unknown>> = {
      LoopCreate: { trigger: "idle", prompt: "Work" }, LoopList: {}, LoopUpdate: { id: "1", status: "continue" }, LoopDelete: { id: "1" },
      WorkflowCreate: { goal: "Work", definition: "{}" }, WorkflowClaim: { id: "1" },
      WorkflowRevise: { id: "1", expectedRevision: 1, expectedState: "a", expectedTransitionSeq: 0, reason: "Edit", changes: [{ op: "add_transition", from: "a", outcome: "ready", to: "a" }] },
      WorkflowTransition: { id: "1", outcome: "ready" },
      OrchestrationCreate: { goal: "Batch", work: [{ prompt: "Independent" }] }, OrchestrationGet: { id: "1" },
      MonitorCreate: { command: "true" }, MonitorList: {}, MonitorUpdate: { monitorId: "1", message: "Progress" }, MonitorStop: { monitorId: "1" },
      TaskCreate: { subject: "Work", description: "Independent" }, TaskList: {}, TaskGet: { id: "1" }, TaskClaim: { id: "1" },
      TaskHeartbeat: { id: "1", claimId: "claim" }, TaskUpdate: { id: "1", status: "completed", claimId: "claim" }, TaskDelete: { id: "1" },
    };
    try {
      const active = compact.session.getActiveToolNames();
      const originals = full.session.getAllTools().filter(tool => Object.hasOwn(valid, tool.name));
      expect(originals).toHaveLength(21);
      expect(compact.session.getCallableToolNames().filter(name => name !== "LoopHelp")).toEqual(full.session.getCallableToolNames());
      for (const original of originals) {
        const shortened = compact.session.getAllTools().find(tool => tool.name === original.name)!;
        expect(shortened.exposure).toBe(original.exposure);
        expect(shortened.promptGuidelines).toBeUndefined();
        const result = await compact.call("LoopHelp", { tool: original.name });
        const text = result.content.find(part => part.type === "text");
        if (text?.type !== "text") throw new Error("Missing original contract");
        expect(JSON.parse(text.text)).toMatchObject({ name: original.name, description: original.description, parameters: JSON.parse(JSON.stringify(original.parameters)) });
        expect(JSON.parse(text.text).promptGuidelines).toEqual(original.promptGuidelines);
        const originalValidator = Compile(original.parameters);
        const shortenedValidator = Compile(shortened.parameters);
        const control = valid[original.name]!;
        expect(originalValidator.Check(control), original.name).toBe(true);
        const cases: unknown[] = [control, {}, null, [], { ...control, unexpected: true }];
        for (const field of Object.keys(control)) for (const replacement of [null, [], {}, true, -1, 0, ""]) cases.push({ ...control, [field]: replacement });
        for (const value of cases) expect(shortenedValidator.Check(value), `${original.name}: ${JSON.stringify(value)}`).toBe(originalValidator.Check(value));
      }
      expect(compact.session.getActiveToolNames()).toEqual(active);
      expect(compact.calls.every(name => name === "LoopHelp")).toBe(true);
      expect(compact.observations.snapshot().complete).toBe(true);
    } finally { await compact.close(); await full.close(); }
  });

  it.each([0, 3000])("retains the guide and full-contract discovery without enabling inactive tools (inline=%s)", async inlineBudget => {
    const instructions: string[] = [];
    const declared: string[][] = [];
    const compact = await createNativeSession({ contextProfile: "compact", mode: "only", inlineBudget, onRequest(context) {
      instructions.push(getCurrentSystemPrompt(context.messages));
      declared.push(getCurrentTools(context.messages).map(tool => tool.name));
    } });
    try {
      compact.session.setActiveToolsByName(compact.session.getActiveToolNames().filter(name => name !== "TaskCreate"));
      const active = compact.session.getActiveToolNames();
      const result = await compact.script(`
        const attempted = await Promise.allSettled([Promise.resolve().then(() => tools.TaskCreate({subject:"Inactive", description:"Must not exist"}))]);
        return { contract: JSON.parse(await tools.LoopHelp({tool:"WorkflowCreate"})), index: JSON.parse(await tools.LoopHelp({})),
          inactive: await tools.LoopHelp({tool:"TaskCreate"}), external: await tools.LoopHelp({tool:"write"}), unknown: await tools.LoopHelp({tool:"constructor"}),
          listed: ALL_TOOLS.some(t => t.name === "TaskCreate"), attempt: attempted[0].status,
          loops: await tools.LoopList({}), tasks: await tools.TaskList({}), monitors: await tools.MonitorList({}) };
      `);
      expect(result.isError).toBe(false);
      const data = JSON.parse(result.content.slice(1).flatMap(part => part.type === "text" ? [part.text] : []).join("\n"));
      expect(data.contract.promptGuidelines.join("\n")).toContain("WorkflowTransition");
      expect(data.index.tools).not.toContain("TaskCreate");
      expect(data.index.tools).toContain("WorkflowCreate");
      for (const key of ["inactive", "external", "unknown"]) expect(data[key]).toContain("No active pi-loop-owned contract");
      expect(data).toMatchObject({ listed: false, attempt: "rejected", tasks: "No tasks.", monitors: "No monitors.", loops: "No loops configured. Use LoopCreate to set up a schedule." });
      expect(instructions[0]).toContain(COMPACT_GUIDE);
      expect(instructions.every(text => text.split("pi-loop compact:").length === 2)).toBe(true);
      expect(declared[0]).not.toContain("LoopHelp");
      expect(declared[0]).not.toContain("WorkflowCreate");
      expect(compact.session.getActiveToolNames()).toEqual(active);
      expect(compact.calls).not.toContain("TaskCreate");
    } finally { await compact.close(); }
  });

  it("preserves schema rejection, permission denial and owned completion checks through native scripts", async () => {
    const compact = await createNativeSession({ contextProfile: "compact", mode: "only", inlineBudget: 0, block: "LoopCreate" });
    try {
      const result = await compact.script(`
        const denied = await Promise.allSettled([tools.LoopCreate({trigger:"5m",prompt:"Must not exist",maxFires:1})]);
        const invalid = await Promise.allSettled([tools.TaskCreate({subject:"Missing description"})]);
        const created = await tools.TaskCreate({subject:"Owned",description:"Independent"});
        const id = created.match(/Task #([^ ]+) created/)[1];
        const claim = await tools.TaskClaim({id});
        const rejected = await tools.TaskUpdate({id,status:"completed"});
        const during = await tools.TaskGet({id});
        const claimId = claim.match(/claimId: ([^\\n]+)/)[1];
        await tools.TaskUpdate({id,status:"completed",claimId});
        return {denied:denied[0].status,invalid:invalid[0].status,rejected,during,after:await tools.TaskGet({id}),loops:await tools.LoopList({})};
      `);
      expect(result.isError).toBe(false);
      const data = JSON.parse(result.content.slice(1).flatMap(part => part.type === "text" ? [part.text] : []).join("\n"));
      expect(data).toMatchObject({ denied: "rejected", invalid: "rejected", rejected: expect.stringContaining("rejected"), during: expect.stringContaining("[in_progress] Owned"), after: expect.stringContaining("[completed] Owned"), loops: "No loops configured. Use LoopCreate to set up a schedule." });
    } finally { await compact.close(); }
  });
});
