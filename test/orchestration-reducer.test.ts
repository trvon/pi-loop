import { describe, expect, it } from "vitest";
import {
  applyOrchestrationEvent,
  createOrchestrationState,
  getOrchestrationCapacity,
  getOrchestrationCounts,
  MAX_ORCHESTRATION_ERROR_CHARS,
  MAX_ORCHESTRATION_RESULT_CHARS,
  validateOrchestrationDefinition,
  validatePersistedOrchestration,
} from "../src/orchestration-reducer.js";

const owner = { sessionId: "session-a", runtimeId: "runtime-a", generation: 2 };

function create(workCount = 3, overrides: Record<string, unknown> = {}) {
  return createOrchestrationState({
    goal: "Review the release surface",
    work: Array.from({ length: workCount }, (_, index) => ({
      prompt: `Inspect subsystem ${index + 1}`,
      agentType: index % 2 === 0 ? "Explore" : "Plan",
    })),
    concurrency: 2,
    maxAttempts: 2,
    ...overrides,
  }, owner, 100);
}

function dispatch(state: ReturnType<typeof create>, workId: string, dispatchId: string, at: number) {
  return applyOrchestrationEvent(state, {
    type: "dispatch_requested",
    at,
    expected: { revision: state.revision, ownerRuntimeId: owner.runtimeId, generation: owner.generation },
    workId,
    dispatchId,
  });
}

describe("subagent orchestration reducer", () => {
  it("validates creation and persisted state boundaries", () => {
    expect(validateOrchestrationDefinition({ goal: "", work: [{ prompt: "inspect" }] })).toContain("goal");
    expect(validateOrchestrationDefinition({ goal: "batch", work: [] })).toContain("work");
    expect(validatePersistedOrchestration(create())).toEqual(create());
    expect(() => validatePersistedOrchestration({ version: 1, status: "active" })).toThrow("Malformed orchestration state");
  });

  it("rejects malformed nested persisted evidence before wake rendering", () => {
    const malformedResult = dispatch(create(1), "1", "dispatch-1", 110).state as any;
    malformedResult.work[0].dispatches[0].result = { unsafe: true };
    expect(() => validatePersistedOrchestration(malformedResult)).toThrow("invalid result");

    const malformedUsage = dispatch(create(1), "1", "dispatch-1", 110).state as any;
    malformedUsage.work[0].dispatches[0].usage = { tokens: { input: "many", output: 1, total: 1 } };
    expect(() => validatePersistedOrchestration(malformedUsage)).toThrow("invalid usage tokens");
  });

  it("creates a finite LoopStore-owned batch with bounded derived counts", () => {
    const state = create();

    expect(state).toMatchObject({
      version: 1,
      revision: 1,
      status: "active",
      goal: "Review the release surface",
      concurrency: 2,
      maxAttempts: 2,
      owner: { ...owner, leaseExpiresAt: expect.any(Number) },
      work: [
        { id: "1", status: "pending", attemptCount: 0, dispatches: [] },
        { id: "2", status: "pending", attemptCount: 0, dispatches: [] },
        { id: "3", status: "pending", attemptCount: 0, dispatches: [] },
      ],
    });
    expect(getOrchestrationCounts(state)).toEqual({ pending: 3, active: 0, completed: 0, failed: 0, uncertain: 0, cancelled: 0 });
  });

  it("reserves capacity before spawn and rejects stale or over-capacity dispatches", () => {
    const initial = create();
    const first = dispatch(initial, "1", "dispatch-1", 110);
    expect(first.applied).toBe(true);
    const second = dispatch(first.state, "2", "dispatch-2", 120);
    expect(second.applied).toBe(true);

    const overCapacity = dispatch(second.state, "3", "dispatch-3", 130);
    expect(overCapacity).toEqual({ applied: false, state: second.state, reason: "capacity_exhausted" });

    const stale = applyOrchestrationEvent(second.state, {
      type: "dispatch_bound",
      at: 140,
      expected: { revision: initial.revision, ownerRuntimeId: owner.runtimeId, generation: owner.generation },
      workId: "1",
      dispatchId: "dispatch-1",
      agentId: "agent-1",
    });
    expect(stale).toEqual({ applied: false, state: second.state, reason: "stale_revision" });
    expect(getOrchestrationCounts(second.state).active).toBe(2);
  });

  it("binds lifecycle identity and settles evidence under provider-owned completion", () => {
    const requested = dispatch(create(1), "1", "dispatch-1", 110).state;
    const bound = applyOrchestrationEvent(requested, {
      type: "dispatch_bound",
      at: 120,
      expected: { revision: requested.revision, ownerRuntimeId: owner.runtimeId, generation: owner.generation },
      workId: "1",
      dispatchId: "dispatch-1",
      agentId: "agent-1",
    }).state;
    const started = applyOrchestrationEvent(bound, {
      type: "dispatch_started",
      at: 130,
      expected: { revision: bound.revision, ownerRuntimeId: owner.runtimeId, generation: owner.generation },
      agentId: "agent-1",
    }).state;
    const settled = applyOrchestrationEvent(started, {
      type: "dispatch_settled",
      at: 140,
      expected: { revision: started.revision, ownerRuntimeId: owner.runtimeId, generation: owner.generation },
      agentId: "agent-1",
      outcome: "completed",
      result: "x".repeat(MAX_ORCHESTRATION_RESULT_CHARS + 100),
      usage: { toolUses: 4, durationMs: 250, tokens: { input: 10, output: 20, total: 30 } },
    });

    expect(settled.applied).toBe(true);
    expect(settled.state.status).toBe("completed");
    expect(settled.state.work[0]).toMatchObject({ status: "completed", attemptCount: 1 });
    expect(settled.state.work[0]?.dispatches[0]).toMatchObject({
      agentId: "agent-1",
      status: "completed",
      consumeStatus: "provider_owned",
      usage: { toolUses: 4, durationMs: 250 },
    });
    expect(settled.state.work[0]?.dispatches[0]?.result).toHaveLength(MAX_ORCHESTRATION_RESULT_CHARS);
    expect(settled.state.pendingWake).toMatchObject({ reason: "completed", sequence: 1 });
  });

  it("retries proved failures but stops at the attempt bound", () => {
    let state = create(1);

    for (let attempt = 1; attempt <= 2; attempt++) {
      const requested = dispatch(state, "1", `dispatch-${attempt}`, 100 + attempt * 10).state;
      const bound = applyOrchestrationEvent(requested, {
        type: "dispatch_bound",
        at: 105 + attempt * 10,
        expected: { revision: requested.revision, ownerRuntimeId: owner.runtimeId, generation: owner.generation },
        workId: "1",
        dispatchId: `dispatch-${attempt}`,
        agentId: `agent-${attempt}`,
      }).state;
      state = applyOrchestrationEvent(bound, {
        type: "dispatch_settled",
        at: 109 + attempt * 10,
        expected: { revision: bound.revision, ownerRuntimeId: owner.runtimeId, generation: owner.generation },
        agentId: `agent-${attempt}`,
        outcome: "failed",
        error: "e".repeat(MAX_ORCHESTRATION_ERROR_CHARS + 100),
      }).state;
    }

    expect(state.status).toBe("needs_attention");
    expect(state.work[0]).toMatchObject({ status: "failed", attemptCount: 2 });
    expect(state.work[0]?.dispatches).toHaveLength(2);
    expect(state.work[0]?.dispatches[1]?.error).toHaveLength(MAX_ORCHESTRATION_ERROR_CHARS);
    expect(state.pendingWake).toMatchObject({ reason: "failed", sequence: 1 });
  });

  it("treats spawn timeouts and expired foreign ownership as uncertain, never automatic retry", () => {
    const requested = dispatch(create(1), "1", "dispatch-1", 110).state;
    const uncertain = applyOrchestrationEvent(requested, {
      type: "dispatch_uncertain",
      at: 120,
      expected: { revision: requested.revision, ownerRuntimeId: owner.runtimeId, generation: owner.generation },
      workId: "1",
      dispatchId: "dispatch-1",
      error: "spawn reply timed out",
    }).state;

    expect(uncertain).toMatchObject({ status: "needs_attention", pendingWake: { reason: "uncertain" } });
    expect(uncertain.work[0]).toMatchObject({ status: "uncertain", attemptCount: 1 });

    const foreign = createOrchestrationState({ goal: "Recover", work: [{ prompt: "inspect" }] }, owner, 100);
    const foreignActive = dispatch(foreign, "1", "dispatch-old", 110).state;
    const beforeExpiry = applyOrchestrationEvent(foreignActive, {
      type: "owner_adopted",
      at: foreignActive.owner.leaseExpiresAt - 1,
      expectedRevision: foreignActive.revision,
      owner: { sessionId: "session-a", runtimeId: "runtime-b", generation: 0 },
    });
    expect(beforeExpiry.reason).toBe("foreign_owner_active");

    const recovered = applyOrchestrationEvent(foreignActive, {
      type: "owner_adopted",
      at: foreignActive.owner.leaseExpiresAt + 1,
      expectedRevision: foreignActive.revision,
      owner: { sessionId: "session-a", runtimeId: "runtime-b", generation: 0 },
    });
    expect(recovered.applied).toBe(true);
    expect(recovered.state.work[0]?.status).toBe("uncertain");
    expect(recovered.state.status).toBe("needs_attention");
  });

  it("acknowledges only the delivered wake sequence and cancels active work atomically", () => {
    const completed = applyOrchestrationEvent(dispatch(create(1), "1", "dispatch-1", 110).state, {
      type: "dispatch_uncertain",
      at: 120,
      expected: { revision: 2, ownerRuntimeId: owner.runtimeId, generation: owner.generation },
      workId: "1",
      dispatchId: "dispatch-1",
      error: "unknown",
    }).state;
    const staleAck = applyOrchestrationEvent(completed, {
      type: "wake_acknowledged",
      at: 130,
      expected: { revision: completed.revision, ownerRuntimeId: owner.runtimeId, generation: owner.generation },
      sequence: 0,
    });
    expect(staleAck.reason).toBe("stale_wake");

    const ack = applyOrchestrationEvent(completed, {
      type: "wake_acknowledged",
      at: 140,
      expected: { revision: completed.revision, ownerRuntimeId: owner.runtimeId, generation: owner.generation },
      sequence: completed.pendingWake!.sequence,
    });
    expect(ack.applied).toBe(true);
    expect(ack.state.pendingWake).toBeUndefined();

    const active = dispatch(create(2), "1", "dispatch-active", 150).state;
    const cancelled = applyOrchestrationEvent(active, {
      type: "cancelled",
      at: 160,
      expected: { revision: active.revision, ownerRuntimeId: owner.runtimeId, generation: owner.generation },
    });
    expect(cancelled.applied).toBe(true);
    expect(cancelled.state.status).toBe("cancelled");
    expect(cancelled.state.work.map((item) => item.status)).toEqual(["cancelled", "cancelled"]);
  });
});

function expectedOf(state: ReturnType<typeof create>) {
  return { revision: state.revision, ownerRuntimeId: owner.runtimeId, generation: owner.generation };
}

interface SettleOptions {
  outcome?: "completed" | "failed";
  result?: string;
  error?: string;
  verify?: { passed: boolean; exitCode: number | null; durationMs: number; output?: string };
  usage?: { durationMs: number; tokens: { input: number; output: number; total: number } };
}

function request(state: ReturnType<typeof create>, workId: string, key: string, at: number) {
  const requested = dispatch(state, workId, `dispatch-${key}`, at);
  expect(requested.applied).toBe(true);
  return applyOrchestrationEvent(requested.state, {
    type: "dispatch_bound", at: at + 1, expected: expectedOf(requested.state), workId, dispatchId: `dispatch-${key}`, agentId: `agent-${key}`,
  }).state;
}

function settle(state: ReturnType<typeof create>, key: string, at: number, options: SettleOptions = {}) {
  return applyOrchestrationEvent(state, {
    type: "dispatch_settled", at, expected: expectedOf(state), agentId: `agent-${key}`,
    outcome: options.outcome ?? "completed", result: options.result, error: options.error, verify: options.verify,
    usage: options.usage,
  }).state;
}

function runToSettled(state: ReturnType<typeof create>, workId: string, key: string, at: number, options: SettleOptions = {}) {
  return settle(request(state, workId, key, at), key, at + 2, options);
}

const tokens = (output: number) => ({ input: 10, output, total: 10 + output });
const pass = { passed: true, exitCode: 0, durationMs: 5 };
const fail = { passed: false, exitCode: 1, durationMs: 5, output: "1 failing test" };

function verifiedBatch(count: number, maxAttempts = 2) {
  return createOrchestrationState({
    goal: "verified batch",
    work: Array.from({ length: count }, (_, index) => ({ prompt: `task ${index + 1}`, verify: `npm test -- task${index + 1}` })),
    pacing: "aimd",
    maxAttempts,
  }, owner, 100);
}

describe("orchestration ACK-clocked pacing", () => {
  it("keeps fixed pacing as the default with unchanged capacity and no window", () => {
    const state = create(3);
    expect(state.window).toBeUndefined();
    expect(getOrchestrationCapacity(state)).toBe(2);
    const first = dispatch(state, "1", "dispatch-1", 110).state;
    expect(dispatch(first, "2", "dispatch-2", 120).applied).toBe(true);
  });

  it("rejects unknown pacing modes and malformed verify commands", () => {
    expect(validateOrchestrationDefinition({ goal: "batch", work: [{ prompt: "inspect" }], pacing: "cubic" as never })).toContain("pacing");
    expect(validateOrchestrationDefinition({ goal: "batch", work: [{ prompt: "inspect", verify: "  " }] })).toContain("verify");
    expect(validateOrchestrationDefinition({ goal: "batch", work: [{ prompt: "inspect", verify: "x".repeat(5000) }] })).toContain("verify");
    expect(validateOrchestrationDefinition({ goal: "batch", work: [{ prompt: "inspect", verify: "npm test" }], pacing: "aimd" })).toBeUndefined();
  });

  it("ignores concurrency under aimd: the window starts at one and may grow to the safety max", () => {
    const state = create(4, { concurrency: 2, pacing: "aimd" });
    expect(state.concurrency).toBe(8);
    expect(state.window).toEqual({ mode: "aimd", cwnd: 1, ssthresh: 8, acks: 0, losses: 0, taskLosses: 0 });
    const first = dispatch(state, "1", "dispatch-1", 110);
    expect(first.applied).toBe(true);
    expect(dispatch(first.state, "2", "dispatch-2", 120)).toMatchObject({ applied: false, reason: "capacity_exhausted" });
  });

  it("uses a passing verifier as the ACK and retries a failing one without shrinking the window", () => {
    let state = verifiedBatch(3);
    state = runToSettled(state, "1", "1", 110, { result: "done", verify: pass });
    expect(state.window).toMatchObject({ cwnd: 2, acks: 1 });
    expect(state.work[0]?.dispatches[0]?.verify).toEqual(pass);

    state = runToSettled(state, "2", "2", 120, { result: "I fixed it", verify: fail });
    expect(state.window).toMatchObject({ cwnd: 2, acks: 1, losses: 0, taskLosses: 1 });
    expect(state.work[1]).toMatchObject({ status: "pending", attemptCount: 1 });
    expect(state.work[1]?.dispatches[0]).toMatchObject({ status: "completed", error: "verify failed (exit 1)", verify: fail });
    expect(state.status).toBe("active");
  });

  it("treats a declared verifier with no evidence as unverified", () => {
    const state = runToSettled(verifiedBatch(1, 1), "1", "1", 110, { result: "done" });
    expect(state.work[0]).toMatchObject({ status: "failed" });
    expect(state.work[0]?.dispatches[0]?.error).toBe("verify did not run");
    expect(state.window).toMatchObject({ cwnd: 1, taskLosses: 1 });
  });

  it("halves on overload errors, resets on timeouts, and ignores generic task errors", () => {
    let state = create(8, { pacing: "aimd", maxAttempts: 3 });
    for (const [index, key] of ["1", "2", "3", "4"].entries()) state = runToSettled(state, String(index + 1), key, 100 + index * 10, { result: "ok" });
    expect(state.window?.cwnd).toBe(5);

    state = runToSettled(state, "5", "5", 200, { outcome: "failed", error: "TypeError in generated code" });
    expect(state.window).toMatchObject({ cwnd: 5, taskLosses: 1, losses: 0 });

    state = runToSettled(state, "5", "6", 210, { outcome: "failed", error: "HTTP 429 rate limit" });
    expect(state.window).toMatchObject({ cwnd: 2, ssthresh: 2, losses: 1, recoverAt: 212 });

    state = runToSettled(state, "5", "7", 220, { outcome: "failed", error: "request timed out" });
    expect(state.window).toMatchObject({ cwnd: 1, losses: 2 });
  });

  it("cuts once per window when parallel workers report congestion together", () => {
    let state = create(6, { pacing: "aimd", maxAttempts: 2 });
    for (const [index, key] of ["1", "2", "3"].entries()) state = runToSettled(state, String(index + 1), key, 100 + index * 10, { result: "ok" });
    expect(getOrchestrationCapacity(state)).toBe(4);
    state = request(state, "4", "a", 200);
    state = request(state, "5", "b", 201);
    state = request(state, "6", "c", 202);
    state = settle(state, "a", 210, { outcome: "failed", error: "503 overloaded" });
    expect(state.window).toMatchObject({ cwnd: 2, recoverAt: 210 });
    state = settle(state, "b", 211, { outcome: "failed", error: "503 overloaded" });
    state = settle(state, "c", 212, { outcome: "failed", error: "503 overloaded" });
    expect(state.window).toMatchObject({ cwnd: 2, losses: 3 });
  });

  it("treats rising per-token latency on a verified success as congestion", () => {
    let state = verifiedBatch(4);
    state = runToSettled(state, "1", "1", 100, { verify: pass, usage: { durationMs: 2_000, tokens: tokens(100) } });
    state = runToSettled(state, "2", "2", 110, { verify: pass, usage: { durationMs: 2_200, tokens: tokens(100) } });
    expect(state.window).toMatchObject({ cwnd: 3, minMsPerToken: 20 });
    state = runToSettled(state, "3", "3", 120, { verify: pass, usage: { durationMs: 6_000, tokens: tokens(100) } });
    expect(state.window).toMatchObject({ cwnd: 1, ssthresh: 1, losses: 1, acks: 2, minMsPerToken: 20 });
    expect(state.work[2]?.status).toBe("completed");
  });

  it("counts spawn failure as congestion", () => {
    let state = create(3, { pacing: "aimd", maxAttempts: 2 });
    state = runToSettled(state, "1", "1", 110, { result: "ok" });
    state = runToSettled(state, "2", "2", 120, { result: "ok" });
    const requested = dispatch(state, "3", "dispatch-3", 130).state;
    const failed = applyOrchestrationEvent(requested, {
      type: "dispatch_spawn_failed", at: 131, expected: expectedOf(requested), workId: "3", dispatchId: "dispatch-3", error: "spawn rejected",
    }).state;
    expect(failed.window).toMatchObject({ cwnd: 1, losses: 1 });
  });

  it("does not open the window when success needed a retry", () => {
    let state = verifiedBatch(1);
    state = runToSettled(state, "1", "a", 110, { verify: fail });
    state = runToSettled(state, "1", "b", 120, { verify: pass });
    expect(state.window).toMatchObject({ cwnd: 1, acks: 1, taskLosses: 1 });
  });

  it("leaves uncertain termination blocking all dispatch regardless of window", () => {
    let state = create(3, { pacing: "aimd" });
    state = runToSettled(state, "1", "1", 110, { result: "ok" });
    const requested = dispatch(state, "2", "dispatch-2", 120).state;
    const uncertain = applyOrchestrationEvent(requested, {
      type: "dispatch_uncertain", at: 121, expected: expectedOf(requested), workId: "2", dispatchId: "dispatch-2", error: "timeout",
    }).state;
    expect(uncertain.window).toEqual(state.window);
    expect(uncertain.status).toBe("needs_attention");
  });

  it("round-trips persisted windows and verification evidence and rejects malformed ones", () => {
    const state = runToSettled(verifiedBatch(2), "1", "1", 110, { verify: fail, usage: { durationMs: 1000, tokens: tokens(50) } });
    expect(validatePersistedOrchestration(structuredClone(state))).toEqual(state);
    const badWindow = structuredClone(state) as any;
    badWindow.window.cwnd = 9;
    expect(() => validatePersistedOrchestration(badWindow)).toThrow("invalid window");
    const badVerify = structuredClone(state) as any;
    badVerify.work[0].dispatches[0].verify = { passed: "yes" };
    expect(() => validatePersistedOrchestration(badVerify)).toThrow("invalid verification");
    const badCommand = structuredClone(state) as any;
    badCommand.work[0].verify = "";
    expect(() => validatePersistedOrchestration(badCommand)).toThrow("invalid verify command");
  });
});
