import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryCredentialStore, PI_AI_VERSION } from "@earendil-works/pi-ai";
import { ModelRuntime, VERSION } from "@earendil-works/pi-coding-agent";
import { createModelObservationCollector, evaluateScenario } from "../test/e2e/controller-routing-evaluation.mjs";
import { createNativeSession } from "./native-session.ts";
import { sourceIdentity } from "./profile-tool-context.ts";
import { boundedJson, contextOptions, sha256, textSize } from "./tool-context-report.ts";

export const NATIVE_ROUTING_ARMS = [
  { name: "direct" },
  { name: "only-default", mode: "only", inlineBudget: 3000 },
  { name: "only-zero", mode: "only", inlineBudget: 0 },
];
const CONTROLLER_TOOLS = ["WorkflowCreate", "TaskCreate", "LoopCreate"];
const ALLOWED_TOOLS = [...CONTROLLER_TOOLS, "codemode"];

export function evaluateNativeEvidence(scenario, evidence, durationMs) {
  if (!evidence.complete) return { status: "incomplete", evaluation: null };
  const calls = evidence.calls;
  const results = new Map(calls.map(call => [call.toolCallId, {
    isError: call.isError,
    tone: call.result?.details?.tone,
    text: (Array.isArray(call.result?.content) ? call.result.content : [])
      .flatMap(part => part.type === "text" ? [part.text] : []).join("\n"),
  }]));
  const evaluation = evaluateScenario(scenario, calls, results, evidence.agentRuns, durationMs);
  return { status: evaluation.success ? "passed" : "failed", evaluation };
}

export async function runNativeRoutingCase(scenario, arm, inference, timeoutMs, sessionFactory = createNativeSession) {
  let fixture;
  let timer;
  const models = createModelObservationCollector();
  const started = performance.now();
  let failure = null;
  let active;
  let callable;
  let activationUnchanged = false;
  try {
    fixture = await sessionFactory({ ...arm, inference, allowTools: [...ALLOWED_TOOLS, ...(arm.contextProfile === "compact" ? ["LoopHelp"] : [])] });
    if (fixture.evidenceKind !== "configured-model") throw new Error("Scripted decisions cannot count as model routing");
    active = fixture.session.getActiveToolNames();
    callable = fixture.session.getCallableToolNames();
    fixture.session.subscribe(event => models.observe(event));
    await Promise.race([
      fixture.prompt(scenario.prompt),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new DOMException("Routing prompt deadline exceeded", "TimeoutError")), timeoutMs); }),
    ]);
    activationUnchanged = JSON.stringify(active) === JSON.stringify(fixture.session.getActiveToolNames());
    if (!activationUnchanged) throw new Error("Routing evaluation changed activation");
  } catch (error) {
    failure = error instanceof Error ? error.name : "Unknown execution failure";
    fixture?.observations.incomplete("Configured-model execution did not settle");
  } finally {
    clearTimeout(timer);
    try { await fixture?.close(); }
    catch { failure = "CleanupFailure"; fixture?.observations.incomplete("Fixture cleanup failed"); }
  }
  const evidence = fixture?.observations.snapshot() ?? { complete: false, calls: [], reasons: ["Fixture setup failed"], agentRuns: 0 };
  const scored = evaluateNativeEvidence(scenario, evidence, performance.now() - started);
  return {
    scenario: scenario.id, arm: arm.name, evidenceKind: "configured-model", failure,
    ...scored, ...models.snapshot(), active, callable, activationUnchanged, evidence,
  };
}

export async function runNativeRouting(args = [], env = process.env, dependencies = {}) {
  const options = contextOptions(args);
  if (!args.includes("--out")) options.out = resolve(".artifacts/live-native-controller-routing");
  if (options.help) {
    process.stdout.write("Usage: npm run test:e2e:routing:native -- [--out DIRECTORY] [--context full|compact]\nExplicit PI_LOOP_NATIVE_ROUTING_MODEL=provider/model required; 18 fresh sessions, memory Pi credentials, provider-standard auth, thinking off. May incur model charges.\n");
    return { status: "help" };
  }
  const arms = NATIVE_ROUTING_ARMS.map(arm => ({ ...arm, ...(options.contextProfile === "compact" ? { contextProfile: "compact" } : {}) }));
  const requestedModel = env.PI_LOOP_NATIVE_ROUTING_MODEL;
  if (!requestedModel) {
    process.stdout.write("SKIP: set PI_LOOP_NATIVE_ROUTING_MODEL=provider/model to opt into native routing evaluation (18 sessions). No model routing pass recorded.\n");
    return { status: "skipped" };
  }
  const separator = requestedModel.indexOf("/");
  if (separator < 1 || !requestedModel.slice(separator + 1).trim()) throw new Error("Expected provider/model, without a thinking suffix");
  const timeoutMs = Number(env.PI_LOOP_LIVE_TIMEOUT_MS ?? 120000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 180000) throw new RangeError("Timeout must be 1..180000 milliseconds");
  const root = fileURLToPath(new URL("..", import.meta.url));
  const source = await sourceIdentity(root, ["benchmarks/evaluate-native-routing.mjs", "test/e2e/controller-routing-evaluation.mjs", "test/fixtures/controller-routing-scenarios.json"]);
  let scenarios;
  try { scenarios = JSON.parse(await readFile(join(root, "test/fixtures/controller-routing-scenarios.json"), "utf8")); }
  catch (cause) { throw new Error("Unable to load frozen controller-routing scenarios", { cause }); }
  if (!Array.isArray(scenarios.scenarios) || scenarios.scenarios.length !== 6
    || scenarios.scenarios.some(scenario => !/^[a-z0-9-]+$/.test(scenario.id)
      || typeof scenario.prompt !== "string" || !scenario.prompt.trim()
      || !CONTROLLER_TOOLS.includes(scenario.expectedTool)
      || !Number.isSafeInteger(scenario.expectedCount) || scenario.expectedCount < 1 || scenario.expectedCount > 3)
    || new Set(scenarios.scenarios.map(scenario => scenario.id)).size !== 6) {
    throw new Error("Expected the frozen six-case routing matrix");
  }
  await mkdir(options.out, { recursive: true });
  const out = await mkdtemp(join(options.out, "run-"));
  const report = {
    schemaVersion: 1, status: "incomplete", complete: false, evidenceKind: "configured-model", requestedModel,
    arms, contextProfile: options.contextProfile ?? "full",
    startedAt: new Date().toISOString(), node: process.version, sdk: VERSION, piAi: PI_AI_VERSION,
    limitations: "One configured model, one pass, seen fixtures. No prompt improvement/convergence, token/cache savings or full-operator-config claim. The inventory differs from the legacy three-controller-only RPC benchmark.",
    source, scenarioVersion: scenarios.version, evaluationVersion: 2,
    fixture: { thinkingLevel: "off", sdkDefaultTools: true, externalExtensions: false, nativeModelsApi: false, memoryCredentials: true, allowedTools: [...ALLOWED_TOOLS, ...(options.contextProfile === "compact" ? ["LoopHelp"] : [])] },
    limits: { sessions: 18, callsPerSession: 64, observationBytesPerSession: 2097152, timeoutMs },
    planned: arms.flatMap(arm => scenarios.scenarios.map(scenario => `${arm.name}/${scenario.id}`)),
    expectedCallable: null, results: [], artifacts: [], failure: null,
  };
  try {
    const runtimeFactory = dependencies.runtimeFactory ?? (config => ModelRuntime.create(config));
    const runtime = await runtimeFactory({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(out, "runtime-cache", "models.json"), refreshOnCreate: false, allowModelNetwork: false });
    const model = runtime.getModel(requestedModel.slice(0, separator), requestedModel.slice(separator + 1));
    if (!model) throw new Error("Requested built-in model unavailable; no fallback attempted");
    const runCase = dependencies.runCase ?? runNativeRoutingCase;
    outer: for (const arm of arms) {
      for (const scenario of scenarios.scenarios) {
        process.stdout.write(`RUN ${arm.name}/${scenario.id}\n`);
        const result = await runCase(scenario, arm, { modelRuntime: runtime, model }, timeoutMs);
        if (result.callable) {
          const callable = [...result.callable].sort((a, b) => a.localeCompare(b, "en"));
          report.expectedCallable ??= callable;
          if (JSON.stringify(callable) !== JSON.stringify(report.expectedCallable)) {
            result.status = "incomplete";
            result.failure = "UnderlyingCallableInventoryChanged";
            result.evaluation = null;
          }
        }
        const file = `${arm.name}-${scenario.id}.json`;
        const raw = boundedJson(result);
        await writeFile(join(out, file), raw, { flag: "wx", mode: 0o600 });
        report.artifacts.push({ file, bytes: textSize(raw).bytes, sha256: sha256(raw) });
        const { evidence: _evidence, evaluation, ...summary } = result;
        report.results.push({ ...summary, evaluation: evaluation ? { ...evaluation, actual: undefined } : null });
        if (result.status === "incomplete") break outer;
      }
    }
    report.complete = report.results.length === report.planned.length && report.results.every(result => result.status !== "incomplete");
    if (!report.complete) report.status = "incomplete";
    else report.status = report.results.every(result => result.status === "passed") ? "passed" : "failed";
  } catch (error) {
    report.failure = error instanceof Error ? error.name : "Unknown evaluation failure";
  } finally {
    try { await rm(join(out, "runtime-cache"), { recursive: true, force: true }); }
    catch { report.complete = false; report.status = "incomplete"; report.failure ??= "RuntimeCacheCleanupFailure"; }
  }
  const pending = join(out, "report.tmp");
  await writeFile(pending, boundedJson(report), { flag: "wx", mode: 0o600 });
  await rename(pending, join(out, "report.json"));
  process.stdout.write(`${JSON.stringify({ report: relative(process.cwd(), join(out, "report.json")), status: report.status, completed: report.results.length, planned: report.planned.length })}\n`);
  return { out, report, status: report.status };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runNativeRouting(process.argv.slice(2));
  if (!["passed", "skipped", "help"].includes(result.status)) process.exitCode = 1;
}
