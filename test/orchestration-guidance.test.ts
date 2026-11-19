import { describe, expect, it, vi } from "vitest";
import { LoopStore } from "../src/store.js";
import { registerSubagentOrchestrationTools } from "../src/tools/subagent-orchestration-tools.js";
import { createToolContextRegistration } from "../src/tools/tool-context.js";
import { createMockPi } from "./helpers/mock-pi.js";

function register(profile?: "compact") {
  const { pi, toolMap } = createMockPi();
  const store = new LoopStore();
  const previous = process.env.PI_LOOP_CONTEXT;
  if (profile) process.env.PI_LOOP_CONTEXT = profile;
  else delete process.env.PI_LOOP_CONTEXT;
  try {
    registerSubagentOrchestrationTools({
      pi,
      registerTool: createToolContextRegistration(pi as any),
      getStore: () => store,
      getScope: () => "session",
      getPiLoopEnv: () => undefined,
      getActor: () => ({ sessionId: "s", runtimeId: "r", generation: 1 }),
      probeSubagents: vi.fn(async () => true),
      updateWidget: vi.fn(),
    });
  } finally {
    if (previous === undefined) delete process.env.PI_LOOP_CONTEXT;
    else process.env.PI_LOOP_CONTEXT = previous;
  }
  return { store, toolMap };
}

describe("orchestration routing guidance", () => {
  it("G1: names the swarm keyword on the tool the model selects from", () => {
    const create = register().toolMap.get("OrchestrationCreate")!;
    expect(create.description).toMatch(/swarm/i);
    expect(create.description).toContain("session LoopStore orchestration");
    expect(register("compact").toolMap.get("OrchestrationCreate")!.description).toMatch(/swarm/i);
  });

  it("G2: says when to use it, when the provider's own tool is right, and which controller owns other shapes", () => {
    const guidance = (register().toolMap.get("OrchestrationCreate")!.promptGuidelines ?? []).join("\n");
    // What it is for.
    expect(guidance).toMatch(/swarm/i);
    expect(guidance).toMatch(/finite list of independent items/);
    expect(guidance).toMatch(/survives restart/);
    // The competing surface: single, chained, or watched delegation stays with the provider.
    expect(guidance).toMatch(/provider's own subagent tool for one delegation, a chain/);
    expect(guidance).toMatch(/never send the same items through both/);
    // One controller per job.
    expect(guidance).toContain("WorkflowCreate");
    expect(guidance).toContain("TaskCreate");
    // What verify buys, and that a worker count is not the default.
    expect(guidance).toMatch(/`verify`, a shell command that exits 0 only when that item is done/);
    expect(guidance).toMatch(/only a fully verified batch may grow past 8 workers/);
    expect(guidance).toMatch(/Omit `concurrency` unless a fixed worker count was requested/);
  });

  it("G3: names verify as a shell exit-0 check, and says so again when the unverified ceiling binds", async () => {
    const { toolMap } = register();
    const create = toolMap.get("OrchestrationCreate")!;
    const verify = (create.parameters as any).properties.work.items.properties.verify.description as string;
    expect(verify).toMatch(/exit 0/);
    expect(verify).toMatch(/shell/i);

    const work = Array.from({ length: 12 }, (_, index) => ({ prompt: `Inspect module ${index}` }));
    const capped = (await create.execute!("call", { goal: "Inspect modules", work })).content[0].text as string;
    expect(capped).toContain("12 work items · aimd window 3-8");
    expect(capped).toContain("Window capped at 8: not every item declares verify.");
    // Controls: no hint when the cap does not bind, or under fixed pacing.
    const small = (await create.execute!("call", { goal: "Inspect two", work: work.slice(0, 2) })).content[0].text as string;
    expect(small).not.toContain("Window capped");
    const fixed = (await create.execute!("call", { goal: "Inspect fixed", work, concurrency: 4 })).content[0].text as string;
    expect(fixed).not.toContain("Window capped");
  });

  it("G4: the guided swarm call is valid and its fully verified batch may exceed eight workers", async () => {
    const { toolMap, store } = register();
    const work = Array.from({ length: 12 }, (_, index) => ({ prompt: `Fix module ${index}`, verify: `node --test test/m${index}.test.js` }));
    const result = await toolMap.get("OrchestrationCreate")!.execute!("call", { goal: "Fix failing modules", work });
    expect(result.content[0].text).toContain("12 work items · aimd window 3-12");
    expect(result.content[0].text).not.toContain("Window capped");
    expect(store.list()[0]?.orchestration?.work).toHaveLength(12);
  });

  it("G5: misuse the guidance warns against is still rejected, not silently accepted", async () => {
    const { toolMap, store } = register();
    const tool = toolMap.get("OrchestrationCreate")!;
    expect((await tool.execute!("call", { goal: "Swarm", work: [] })).content[0].text).toContain("between 1 and 32 work items");
    expect((await tool.execute!("call", { goal: "Swarm", work: [{ prompt: "A", verify: "  " }] })).content[0].text).toContain("verify must contain");
    expect(store.list()).toHaveLength(0);
  });
});
