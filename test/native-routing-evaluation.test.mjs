import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluateNativeEvidence, NATIVE_ROUTING_ARMS, runNativeRouting, runNativeRoutingCase } from "../benchmarks/evaluate-native-routing.mjs";
import { createNativeSession } from "../benchmarks/native-session.ts";
import { createToolObserver } from "../benchmarks/native-tool-observer.ts";
import { sha256 } from "../benchmarks/tool-context-report.ts";

const dirs = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), "native-routing-test-"));
  dirs.push(dir);
  return dir;
}
const scenario = { id: "independent", expectedTool: "TaskCreate", expectedCount: 1, argumentCheck: "independent-tasks" };

function fakeFixture() {
  const observations = createToolObserver();
  observations.agentStart();
  return {
    evidenceKind: "configured-model", observations, close: vi.fn(async () => {}),
    session: { getActiveToolNames: () => [], getCallableToolNames: () => [], subscribe: vi.fn() },
    prompt: vi.fn(async () => {}),
  };
}

describe("discovery-aware routing evaluation measurement", () => {
  it("scores actual direct and nested creation results identically without interpreting script output", async () => {
    for (const arm of NATIVE_ROUTING_ARMS) {
      const fixture = await createNativeSession(arm);
      try {
        const args = { subject: "Independent item", description: "A separately completable fixture deliverable" };
        if (arm.mode) await fixture.script(`await tools.TaskCreate(${JSON.stringify(args)}); return "arbitrary non-evidence text";`);
        else await fixture.call("TaskCreate", args);
        const scored = evaluateNativeEvidence(scenario, fixture.observations.snapshot(), 1);
        expect(scored.status).toBe("passed");
        expect(scored.evaluation).toMatchObject({ accuracy: 1, firstAttemptValid: true, firstAttemptSemantic: true });
      } finally { await fixture.close(); }
    }
  });

  it("replays valid payloads for all six frozen fixtures across three arms without claiming model decisions", async () => {
    const frozen = JSON.parse(await readFile(new URL("./fixtures/controller-routing-scenarios.json", import.meta.url), "utf8"));
    const definition = JSON.stringify({ version: 1, initialState: "investigate", states: {
      investigate: { prompt: "Investigate", task: { subject: "Investigate", description: "Record current behavior" }, on: { ready: "implement" } },
      implement: { prompt: "Implement", task: { subject: "Implement", description: "Implement verified findings" }, on: { ready: "validate" } },
      validate: { prompt: "Validate", task: { subject: "Validate", description: "Run observable tests" }, on: { failed: "implement", passed: "complete" } },
      complete: { prompt: "Report results", terminal: "completed" },
    } });
    let callable;
    for (const arm of NATIVE_ROUTING_ARMS) for (const entry of frozen.scenarios) {
      const fixture = await createNativeSession(arm);
      try {
        const current = fixture.session.getCallableToolNames();
        callable ??= current;
        expect(current).toEqual(callable);
        let args;
        if (entry.expectedTool === "WorkflowCreate") args = [{ goal: "Fixture phased work", definition }];
        else if (entry.expectedTool === "TaskCreate") args = ["Documentation", "Dependencies", "Announcement"].map(subject => ({ subject, description: `Independently complete the ${subject} fixture artifact` }));
        else if (entry.argumentCheck === "idle-loop") args = [{ trigger: "idle", triggerType: "idle", recurring: true, prompt: "Fix broken internal links" }];
        else args = [{ trigger: "10m", recurring: true, maxFires: 12, prompt: "Check deployment health" }];
        if (arm.mode) await fixture.script(`for (const args of ${JSON.stringify(args)}) await tools.${entry.expectedTool}(args);`);
        else await fixture.callMany(args.map(value => ({ name: entry.expectedTool, args: value })));
        const result = evaluateNativeEvidence(entry, fixture.observations.snapshot(), 1);
        expect(result.status, `${arm.name}/${entry.id}`).toBe("passed");
        expect(result.evaluation).toMatchObject({ accuracy: 1, firstAttemptSemantic: true });
        expect(fixture.evidenceKind).toBe("scripted-conformance");
      } finally { await fixture.close(); }
    }
  });

  it("uses the supplied model runtime and prompt without queuing scripted controller choices", async () => {
    const prompts = [];
    const provider = await createNativeSession({ onRequest(context) {
      prompts.push(...context.messages.filter(message => message.role === "user").map(message => message.content));
    } });
    const inference = { modelRuntime: provider.session.modelRuntime, model: provider.session.model };
    const configured = await createNativeSession({ mode: "only", inference });
    try {
      expect(configured.evidenceKind).toBe("configured-model");
      await expect(configured.call("TaskCreate", { subject: "Must not queue", description: "Scripted choices forbidden" })).rejects.toThrow(/Scripted tool choices/);
      await configured.prompt("A fixed test-only prompt without forced tool choices.");
      expect(prompts).toEqual([[{ type: "text", text: "A fixed test-only prompt without forced tool choices." }]]);
      expect(configured.observations.snapshot()).toMatchObject({ complete: true, calls: [] });
      expect(evaluateNativeEvidence(scenario, configured.observations.snapshot(), 1).status).toBe("failed");
      const scored = await runNativeRoutingCase(scenario, NATIVE_ROUTING_ARMS[2], inference, 1000);
      expect(scored.status).toBe("failed");
      expect(scored.observedModels).toEqual([{ provider: "codemode-fixture", model: "scripted", api: "openai-completions" }]);
    } finally { await configured.close(); await provider.close(); }
  });

  it("does not count fulfilled business rejections or missing observations as successful routing", async () => {
    const fixture = await createNativeSession({ mode: "only" });
    try {
      await fixture.script('await tools.WorkflowCreate({goal:"Invalid definition fixture", definition:"{}"}); return "success claimed by script";');
      const evidence = fixture.observations.snapshot();
      const scored = evaluateNativeEvidence({ ...scenario, expectedTool: "WorkflowCreate", argumentCheck: "workflow-rework" }, evidence, 1);
      expect(evidence.calls.find(call => call.name === "WorkflowCreate")).toMatchObject({ isError: false, result: { details: { tone: "error" } } });
      expect(scored.status).toBe("failed");
      expect(scored.evaluation.firstAttemptValid).toBe(false);
      expect(evaluateNativeEvidence(scenario, { ...evidence, complete: false }, 1)).toEqual({ status: "incomplete", evaluation: null });
    } finally { await fixture.close(); }
  });

  it("skips without model configuration and validates options before touching model credentials or output", async () => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const dir = await directory();
    const runtimeFactory = vi.fn();
    const dependencies = { runtimeFactory };
    expect(await runNativeRouting(["--out", dir], {}, dependencies)).toEqual({ status: "skipped" });
    expect(await runNativeRouting(["--help"], {}, dependencies)).toEqual({ status: "help" });
    for (const [args, env] of [
      [["--unknown"], {}], [["--out"], {}],
      [["--out", dir], { PI_LOOP_NATIVE_ROUTING_MODEL: "invalid" }],
      [["--out", dir], { PI_LOOP_NATIVE_ROUTING_MODEL: "p/m", PI_LOOP_LIVE_TIMEOUT_MS: "2garbage" }],
      [["--out", dir], { PI_LOOP_NATIVE_ROUTING_MODEL: "p/m", PI_LOOP_LIVE_TIMEOUT_MS: "180001" }],
    ]) await expect(runNativeRouting(args, env, dependencies)).rejects.toThrow();
    expect(runtimeFactory).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual([]);
  });

  it("retains completed cases and checksummed artifacts when the next case is unavailable", async () => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const dir = await directory();
    let attempts = 0;
    const dependencies = {
      runtimeFactory: vi.fn(async () => ({ getModel: () => ({ id: "fake-test-only" }) })),
      runCase: async (entry, arm) => {
        if (++attempts === 2) throw new Error("Provider unavailable; do not continue or fall back");
        return { scenario: entry.id, arm: arm.name, status: "passed", callable: ["TaskCreate"], evaluation: { success: true }, evidence: { complete: true, calls: [] } };
      },
    };
    const result = await runNativeRouting(["--out", dir], { PI_LOOP_NATIVE_ROUTING_MODEL: "p/m" }, dependencies);
    expect(result.report).toMatchObject({ complete: false, status: "incomplete", failure: "Error" });
    expect(result.report.planned).toHaveLength(18);
    expect(result.report.results).toHaveLength(1);
    expect(attempts).toBe(2);
    const artifact = result.report.artifacts[0];
    expect(sha256(await readFile(join(result.out, artifact.file), "utf8"))).toBe(artifact.sha256);
    expect(JSON.parse(await readFile(join(result.out, "report.json"), "utf8"))).toMatchObject({ status: "incomplete" });
    expect(dependencies.runtimeFactory.mock.calls[0][0]).toMatchObject({ modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  });

  it("does not claim a comparable matrix after callable inventory changes", async () => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const dir = await directory();
    let attempts = 0;
    const result = await runNativeRouting(["--out", dir], { PI_LOOP_NATIVE_ROUTING_MODEL: "p/m" }, {
      runtimeFactory: async () => ({ getModel: () => ({ id: "fake-test-only" }) }),
      runCase: async (entry, arm) => ({ scenario: entry.id, arm: arm.name, status: "passed", callable: ++attempts === 1 ? ["TaskCreate"] : [], evidence: { complete: true, calls: [] }, evaluation: { success: true } }),
    });
    expect(result.report.status).toBe("incomplete");
    expect(attempts).toBe(2);
    expect(result.report.results[1].failure).toBe("UnderlyingCallableInventoryChanged");
  });

  it("keeps prompt failures, deadlines and cleanup failures incomplete and forbids scripted live choices", async () => {
    const scripted = await runNativeRoutingCase(scenario, NATIVE_ROUTING_ARMS[0], {}, 1000, () => createNativeSession());
    expect(scripted.status).toBe("incomplete");
    const rejected = fakeFixture();
    rejected.prompt.mockRejectedValue(new Error("provider failure"));
    const failure = await runNativeRoutingCase(scenario, NATIVE_ROUTING_ARMS[0], {}, 1000, async () => rejected);
    expect(failure.status).toBe("incomplete");
    expect(rejected.close).toHaveBeenCalledOnce();
    const cleanup = fakeFixture();
    cleanup.close.mockRejectedValue(new Error("cleanup failure"));
    expect(await runNativeRoutingCase(scenario, NATIVE_ROUTING_ARMS[0], {}, 1000, async () => cleanup)).toMatchObject({ status: "incomplete", failure: "CleanupFailure" });
    vi.useFakeTimers();
    const hung = fakeFixture();
    hung.prompt.mockReturnValue(new Promise(() => {}));
    const pending = runNativeRoutingCase(scenario, NATIVE_ROUTING_ARMS[0], {}, 2, async () => hung);
    await vi.advanceTimersByTimeAsync(3);
    expect(await pending).toMatchObject({ status: "incomplete", failure: "TimeoutError" });
    expect(hung.close).toHaveBeenCalledOnce();
  });
});
