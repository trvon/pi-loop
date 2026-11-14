/**
 * Deterministic simulation: fixed orchestration concurrency vs. the opt-in
 * Reno-style ACK window, driven through the real orchestration reducer.
 *
 * The environment is synthetic. A hidden shared bottleneck (one local GPU, a
 * rate-limited provider) serves `bottleneck` workers at full speed; past that,
 * every worker slows proportionally and may fail with an overload error.
 * An overload is an admission rejection by default: it fails fast, before the
 * worker runs a tool, so it may be re-sent without spending an attempt. In the
 * mid-run scenario it strikes after the worker has used tools, so a re-run is
 * an ordinary charged retry. Independently, some tasks simply fail their own
 * check. The controller is
 * never told the bottleneck. Scenarios include ones where AIMD should lose;
 * results describe this model only, not live Pi sessions.
 *
 * Run: npm run sim:ack-window
 */
import { applyOrchestrationEvent, createOrchestrationState, getOrchestrationCapacity, getOrchestrationCounts } from "../src/orchestration-reducer.js";
import type { OrchestrationPacing, OrchestrationState } from "../src/types.js";

interface Scenario {
  name: string;
  bottleneck: number;
  overloadFailure: number;
  taskFailure: number;
  heterogeneous: boolean;
  /** Overload strikes after tool use instead of at admission. */
  midRunOverload?: boolean;
  maxAttempts?: number;
}

const SCENARIOS: Scenario[] = [
  { name: "severe overload", bottleneck: 4, overloadFailure: 0.45, taskFailure: 0.03, heterogeneous: false },
  { name: "mild overload", bottleneck: 4, overloadFailure: 0.1, taskFailure: 0.03, heterogeneous: false },
  { name: "hard tasks, no overload loss", bottleneck: 4, overloadFailure: 0, taskFailure: 0.25, heterogeneous: false },
  { name: "hard tasks + severe overload", bottleneck: 4, overloadFailure: 0.45, taskFailure: 0.25, heterogeneous: false },
  { name: "variable task sizes", bottleneck: 4, overloadFailure: 0.45, taskFailure: 0.03, heterogeneous: true },
  { name: "tight bottleneck", bottleneck: 2, overloadFailure: 0.45, taskFailure: 0.03, heterogeneous: false },
  { name: "severe overload, maxAttempts=1 (tool default)", bottleneck: 4, overloadFailure: 0.45, taskFailure: 0.03, heterogeneous: false, maxAttempts: 1 },
  { name: "severe mid-run overload (after tool use)", bottleneck: 4, overloadFailure: 0.45, taskFailure: 0.03, heterogeneous: false, midRunOverload: true },
];

const owner = { sessionId: "sim", runtimeId: "sim", generation: 1 };
const WORK_ITEMS = 24;
const MAX_ATTEMPTS = 3;
const MS_PER_TOKEN = 20;
const BASE_TOKENS = 500;
const TICK_MS = 1_000;
const SEEDS = 200;
const MAX_TICKS = 50_000;

interface Job { agentId: string; finishAt: number; durationMs: number; outputTokens: number; toolUses: number; error?: string }
interface Outcome { completed: number; ticks: number; dispatches: number; halted: boolean }

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function run(scenario: Scenario, pacing: OrchestrationPacing, concurrency: number, seed: number): Outcome {
  const random = mulberry32(seed);
  let state: OrchestrationState = createOrchestrationState({
    goal: "sim",
    work: Array.from({ length: WORK_ITEMS }, (_, i) => ({ prompt: `item ${i + 1}` })),
    concurrency,
    maxAttempts: scenario.maxAttempts ?? MAX_ATTEMPTS,
    pacing,
  }, owner, 0);
  const expected = () => ({ revision: state.revision, ownerRuntimeId: owner.runtimeId, generation: owner.generation });
  const apply = (event: Parameters<typeof applyOrchestrationEvent>[1]) => {
    const result = applyOrchestrationEvent(state, event);
    if (!result.applied) throw new Error(`sim event rejected: ${event.type} ${result.reason}`);
    state = result.state;
  };
  const jobs: Job[] = [];
  let dispatches = 0;
  let tick = 0;

  for (; tick < MAX_TICKS; tick++) {
    const at = tick * TICK_MS;
    for (const job of jobs.filter((candidate) => candidate.finishAt <= tick)) {
      jobs.splice(jobs.indexOf(job), 1);
      apply({
        type: "dispatch_settled",
        at,
        expected: expected(),
        agentId: job.agentId,
        outcome: job.error ? "failed" : "completed",
        result: job.error ? undefined : "ok",
        error: job.error,
        usage: { toolUses: job.toolUses, durationMs: job.durationMs, tokens: { input: 100, output: job.outputTokens, total: 100 + job.outputTokens } },
      });
    }
    while (state.status === "active" && getOrchestrationCounts(state).active < getOrchestrationCapacity(state)) {
      const item = state.work.find((candidate) => candidate.status === "pending");
      if (!item) break;
      const dispatchId = `d${++dispatches}`;
      apply({ type: "dispatch_requested", at, expected: expected(), workId: item.id, dispatchId });
      apply({ type: "dispatch_bound", at, expected: expected(), workId: item.id, dispatchId, agentId: `a${dispatchId}` });
      const inFlight = jobs.length + 1;
      const slowdown = Math.max(1, inFlight / scenario.bottleneck);
      const outputTokens = Math.round(BASE_TOKENS * (scenario.heterogeneous ? 0.3 + random() * 3 : 1));
      const durationMs = outputTokens * MS_PER_TOKEN * slowdown;
      const overloadRoll = random();
      const taskRoll = random();
      const error = inFlight > scenario.bottleneck && overloadRoll < scenario.overloadFailure
        ? "503 overloaded"
        : taskRoll < scenario.taskFailure ? "assertion failed in generated code" : undefined;
      if (error === "503 overloaded" && !scenario.midRunOverload) {
        jobs.push({ agentId: `a${dispatchId}`, finishAt: tick + 1, durationMs: TICK_MS, outputTokens: 0, toolUses: 0, error });
        continue;
      }
      jobs.push({ agentId: `a${dispatchId}`, finishAt: tick + Math.max(1, Math.ceil(durationMs / TICK_MS)), durationMs, outputTokens, toolUses: 3, error });
    }
    if (jobs.length === 0 && (state.status !== "active" || !state.work.some((candidate) => candidate.status === "pending"))) break;
  }
  return { completed: getOrchestrationCounts(state).completed, ticks: tick, dispatches, halted: state.status === "needs_attention" };
}

function percentile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * q)]!;
}

const configs: Array<{ label: string; pacing: OrchestrationPacing; concurrency: number }> = [
  ...[1, 2, 4, 6, 8].map((concurrency) => ({ label: `fixed c=${concurrency}`, pacing: "fixed" as const, concurrency })),
  { label: "aimd", pacing: "aimd", concurrency: 8 },
];

console.log(`work=${WORK_ITEMS} maxAttempts=${MAX_ATTEMPTS} seeds=${SEEDS}; seconds are median [p10-p90]`);
for (const scenario of SCENARIOS) {
  console.log(`\n${scenario.name}: bottleneck=${scenario.bottleneck} overloadFail=${scenario.overloadFailure} taskFail=${scenario.taskFailure}${scenario.heterogeneous ? " heterogeneous" : ""}`);
  console.log("config      | batch finished | items done | seconds            | dispatches");
  for (const config of configs) {
    const outcomes = Array.from({ length: SEEDS }, (_, seed) => run(scenario, config.pacing, config.concurrency, seed + 1));
    const finished = outcomes.filter((o) => !o.halted && o.completed === WORK_ITEMS).length / SEEDS;
    const ticks = outcomes.map((o) => o.ticks);
    console.log([
      config.label.padEnd(11),
      `${(finished * 100).toFixed(0).padStart(13)}%`,
      String(percentile(outcomes.map((o) => o.completed), 0.5)).padStart(10),
      `${percentile(ticks, 0.5)} [${percentile(ticks, 0.1)}-${percentile(ticks, 0.9)}]`.padEnd(18),
      String(percentile(outcomes.map((o) => o.dispatches), 0.5)).padStart(10),
    ].join(" | "));
  }
}
