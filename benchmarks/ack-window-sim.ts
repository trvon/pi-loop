/**
 * Deterministic simulation: fixed orchestration concurrency vs. the opt-in
 * ACK-clocked AIMD window, driven through the real orchestration reducer.
 *
 * The environment is synthetic. A hidden shared bottleneck (one local GPU, a
 * rate-limited provider) serves `bottleneck` workers well; past that, every
 * worker slows proportionally and fails far more often. The controller is
 * never told the bottleneck. Results describe this model only, not live Pi
 * sessions.
 *
 * Run: node --import tsx benchmarks/ack-window-sim.ts
 */
import { applyOrchestrationEvent, createOrchestrationState, getOrchestrationCapacity, getOrchestrationCounts } from "../src/orchestration-reducer.js";
import type { OrchestrationPacing, OrchestrationState } from "../src/types.js";

const owner = { sessionId: "sim", runtimeId: "sim", generation: 1 };
const WORK_ITEMS = 24;
const MAX_ATTEMPTS = 3;
const BASE_TICKS = 10;
const BASE_FAILURE = 0.03;
const OVERLOAD_FAILURE = 0.45;
const SEEDS = 200;
const MAX_TICKS = 20_000;

interface Job { workId: string; agentId: string; finishAt: number; fails: boolean }
interface Outcome { completed: number; ticks: number; dispatches: number; losses: number; halted: boolean }

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

function run(pacing: OrchestrationPacing, concurrency: number, bottleneck: number, seed: number): Outcome {
  const random = mulberry32(seed);
  let state: OrchestrationState = createOrchestrationState({
    goal: "sim",
    work: Array.from({ length: WORK_ITEMS }, (_, i) => ({ prompt: `item ${i + 1}` })),
    concurrency,
    maxAttempts: MAX_ATTEMPTS,
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
  let losses = 0;
  let tick = 0;

  for (; tick < MAX_TICKS; tick++) {
    for (const job of jobs.filter((candidate) => candidate.finishAt <= tick)) {
      jobs.splice(jobs.indexOf(job), 1);
      if (job.fails) losses += 1;
      apply({ type: "dispatch_settled", at: tick, expected: expected(), agentId: job.agentId, outcome: job.fails ? "failed" : "completed", result: job.fails ? undefined : "ok" });
    }
    while (state.status === "active" && getOrchestrationCounts(state).active < getOrchestrationCapacity(state)) {
      const item = state.work.find((candidate) => candidate.status === "pending");
      if (!item) break;
      const dispatchId = `d${++dispatches}`;
      apply({ type: "dispatch_requested", at: tick, expected: expected(), workId: item.id, dispatchId });
      apply({ type: "dispatch_bound", at: tick, expected: expected(), workId: item.id, dispatchId, agentId: `a${dispatchId}` });
      const inFlight = jobs.length + 1;
      const overloaded = inFlight > bottleneck;
      jobs.push({
        workId: item.id,
        agentId: `a${dispatchId}`,
        finishAt: tick + Math.ceil(BASE_TICKS * Math.max(1, inFlight / bottleneck)),
        fails: random() < (overloaded ? OVERLOAD_FAILURE : BASE_FAILURE),
      });
    }
    if (jobs.length === 0 && (state.status !== "active" || !state.work.some((candidate) => candidate.status === "pending"))) break;
  }
  return { completed: getOrchestrationCounts(state).completed, ticks: tick, dispatches, losses, halted: state.status === "needs_attention" };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

const configs: Array<{ label: string; pacing: OrchestrationPacing; concurrency: number }> = [
  ...[1, 2, 3, 4, 6, 8].map((concurrency) => ({ label: `fixed c=${concurrency}`, pacing: "fixed" as const, concurrency })),
  { label: "aimd  c<=8", pacing: "aimd", concurrency: 8 },
];

console.log(`work=${WORK_ITEMS} maxAttempts=${MAX_ATTEMPTS} seeds=${SEEDS} baseFail=${BASE_FAILURE} overloadFail=${OVERLOAD_FAILURE}`);
for (const bottleneck of [2, 4, 6]) {
  console.log(`\nhidden bottleneck = ${bottleneck} workers`);
  console.log("config        | finished batch | median items | median ticks | median losses | median dispatches");
  for (const config of configs) {
    const outcomes = Array.from({ length: SEEDS }, (_, seed) => run(config.pacing, config.concurrency, bottleneck, seed + 1));
    const finished = outcomes.filter((o) => !o.halted && o.completed === WORK_ITEMS).length / SEEDS;
    console.log([
      config.label.padEnd(13),
      `${(finished * 100).toFixed(0).padStart(13)}%`,
      String(median(outcomes.map((o) => o.completed))).padStart(12),
      String(median(outcomes.map((o) => o.ticks))).padStart(12),
      String(median(outcomes.map((o) => o.losses))).padStart(13),
      String(median(outcomes.map((o) => o.dispatches))).padStart(17),
    ].join(" | "));
  }
}
