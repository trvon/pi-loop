import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assistantModelMetadata, createModelObservationCollector, evaluateScenario } from "./e2e/controller-routing-evaluation.mjs";

const scenarios = JSON.parse(readFileSync(new URL("./fixtures/controller-routing-scenarios.json", import.meta.url), "utf8")).scenarios;
const workflowDefinition = {
  version: 1, initialState: "work",
  states: {
    work: { prompt: "Work.", task: { subject: "Work", description: "Record work." }, on: { ready: "verify", retry: "work" }, maxAttempts: 2 },
    verify: { prompt: "Verify.", task: { subject: "Verify", description: "Record evidence." }, on: { failed: "work", passed: "done" } },
    done: { prompt: "Report.", terminal: "completed" },
  },
};
const accepted = { isError: false, tone: "success", text: "Created" };
const denied = { isError: false, tone: "error", text: "Definition rejected" };
const workflowScenario = scenarios.find((scenario) => scenario.id === "ordered-task-series");

function argsFor(scenario, index) {
  if (scenario.argumentCheck === "workflow-rework") return { goal: "Repair", definition: JSON.stringify(workflowDefinition) };
  if (scenario.argumentCheck === "independent-tasks") return { subject: `Independent ${index}`, description: "An independently assignable preparation artifact." };
  if (scenario.argumentCheck === "bounded-cron-loop") return { trigger: "10m", prompt: "Report when healthy", maxFires: 12 };
  return { trigger: "idle", triggerType: "idle", prompt: "Fix broken links" };
}
function callsFor(scenario) {
  return Array.from({ length: scenario.expectedCount }, (_, index) => ({
    name: scenario.expectedTool, args: argsFor(scenario, index), toolCallId: String(index), agentRun: 1,
  }));
}
function evaluate(scenario, calls, results = new Map(calls.map((call) => [call.toolCallId, accepted]))) {
  return evaluateScenario(scenario, calls, results, 1, 20);
}

describe("actual model observation expectations", () => {
  it("records only response metadata, never assistant content or owner fields", () => {
    const message = { role: "assistant", provider: "openai", model: "gpt-6.1-sol", api: "openai-responses", content: "private", sessionId: "owner" };
    expect(assistantModelMetadata({ type: "message_end", message })).toEqual({ provider: "openai", model: "gpt-6.1-sol", api: "openai-responses" });
  });
  it.each([
    { type: "message_end", message: { role: "user", provider: "p", model: "m" } },
    { type: "message_end", message: { role: "assistant", provider: "p" } },
    { type: "message_end", message: { role: "assistant", provider: "", model: "m" } },
    { type: "tool_execution_end", message: { role: "assistant", provider: "p", model: "m" } },
  ])("does not fabricate metadata from %j", (event) => {
    expect(assistantModelMetadata(event)).toBeUndefined();
  });
  it("retains eight identities and counts every omitted observation, not retained duplicates", () => {
    const collector = createModelObservationCollector();
    const event = (index) => ({ type: "message_end", message: { role: "assistant", provider: "p", model: `model-${index}` } });
    for (let index = 0; index < 8; index += 1) collector.observe(event(index));
    expect(collector.snapshot().observedModels).toHaveLength(8);
    expect(collector.snapshot().omittedModelObservations).toBe(0);
    collector.observe(event(8));
    collector.observe(event(8));
    collector.observe(event(0));
    expect(collector.snapshot().observedModels.map((metadata) => metadata.model)).toEqual(Array.from({ length: 8 }, (_, index) => `model-${index}`));
    expect(collector.snapshot().omittedModelObservations).toBe(2);
  });
  it("does not expose private collector state through snapshots or count missing metadata", () => {
    const collector = createModelObservationCollector();
    collector.observe({ type: "message_end", message: { role: "assistant", provider: "p", model: "original" } });
    const snapshot = collector.snapshot();
    snapshot.observedModels[0].model = "changed";
    snapshot.observedModels.push({ provider: "other", model: "extra" });
    collector.observe({ type: "message_end", message: { role: "assistant" } });
    expect(collector.snapshot()).toEqual({ observedModels: [{ provider: "p", model: "original" }], omittedModelObservations: 0 });
  });
  it("bounds captured metadata strings", () => {
    const metadata = assistantModelMetadata({ type: "message_end", message: { role: "assistant", provider: "p".repeat(300), model: "m".repeat(300) } });
    expect(metadata.provider).toHaveLength(256);
    expect(metadata.model).toHaveLength(256);
  });
});

// These judgments are fixed before implementing the new measurement fields.
describe("first-attempt conformance expectations and routing invariants", () => {
  it.each(scenarios)("reports first-batch validity/semantics without changing routing for $id", (scenario) => {
    const calls = callsFor(scenario);
    const result = evaluate(scenario, calls);
    expect(result).toMatchObject({ success: true, accuracy: 1, firstAttemptValid: true, firstAttemptSemantic: true, retryCount: 0 });
    expect(result.checklist.map((item) => item.id)).toEqual(["route", "execution", "arguments", "single-turn"]);
    expect(result.checklist.filter((item) => item.critical)).toHaveLength(2);
  });

  it("records repaired schema failure separately from final routing success", () => {
    const calls = callsFor(workflowScenario);
    calls.unshift({ ...calls[0], args: { goal: "Repair", definition: "{}" }, toolCallId: "bad" });
    const results = new Map([["bad", denied], ["0", accepted]]);
    expect(evaluate(workflowScenario, calls, results)).toMatchObject({
      success: true, accuracy: 1, firstAttemptValid: false, firstAttemptSemantic: false, retryCount: 1,
    });
  });

  it("does not confuse schema validity with scenario semantics", () => {
    const calls = callsFor(workflowScenario);
    calls[0].args.definition = JSON.stringify({ version: 1, initialState: "work", states: {
      work: { prompt: "Work.", on: { done: "done" } }, done: { prompt: "Report.", terminal: "completed" },
    } });
    expect(evaluate(workflowScenario, calls)).toMatchObject({
      success: true, accuracy: 0.75, firstAttemptValid: true, firstAttemptSemantic: false,
    });
  });

  it.each([undefined, { isError: true, tone: "success", text: "Failed" }, denied])("never treats missing/rejected results as a first-attempt pass (%j)", (result) => {
    const calls = callsFor(workflowScenario);
    const results = new Map(result ? [["0", result]] : []);
    expect(evaluate(workflowScenario, calls, results)).toMatchObject({ success: false, firstAttemptValid: false, firstAttemptSemantic: false });
  });

  it("preserves competing-controller rejection even when a later workflow succeeds", () => {
    const calls = callsFor(workflowScenario);
    calls.unshift({ name: "TaskCreate", args: { subject: "Wrong owner" }, toolCallId: "wrong", agentRun: 1 });
    expect(evaluate(workflowScenario, calls)).toMatchObject({ success: false, firstAttemptValid: false, firstAttemptSemantic: false });
  });

  it("keeps first-attempt success distinct from a later failed final attempt", () => {
    const calls = callsFor(workflowScenario);
    calls.push({ ...calls[0], toolCallId: "later" });
    expect(evaluate(workflowScenario, calls, new Map([["0", accepted], ["later", denied]]))).toMatchObject({
      success: false, firstAttemptValid: true, firstAttemptSemantic: true,
    });
  });

  it("requires the entire three-task first batch, not just its first successful call", () => {
    const scenario = scenarios.find((item) => item.argumentCheck === "independent-tasks");
    const calls = callsFor(scenario);
    calls.push({ ...calls[1], toolCallId: "repair" });
    const results = new Map(calls.map((call) => [call.toolCallId, call.toolCallId === "1" ? denied : accepted]));
    expect(evaluate(scenario, calls, results)).toMatchObject({ success: true, firstAttemptValid: false, firstAttemptSemantic: false });
  });

  it("keeps timing independent from first-batch validity and semantics", () => {
    const calls = callsFor(workflowScenario).map((call) => ({ ...call, agentRun: 2 }));
    expect(evaluate(workflowScenario, calls)).toMatchObject({ success: true, accuracy: 0.75, firstAttemptValid: true, firstAttemptSemantic: true });
  });

  it("does not mutate frozen observations or result evidence", () => {
    const calls = Object.freeze(callsFor(workflowScenario).map((call) => Object.freeze({ ...call, args: Object.freeze(call.args) })));
    const results = new Map([["0", Object.freeze({ ...accepted })]]);
    const before = JSON.stringify({ calls, results: [...results] });
    evaluate(Object.freeze({ ...workflowScenario }), calls, results);
    expect(JSON.stringify({ calls, results: [...results] })).toBe(before);
  });
});
