import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createSubagentOrchestrationRuntime } from "../src/runtime/subagent-orchestration-runtime.js";
import { runVerifyCommand, type VerifyRequest } from "../src/runtime/verify-runner.js";
import { LoopStore } from "../src/store.js";
import type { OrchestrationActor, OrchestrationVerification } from "../src/types.js";
import { createMockPi } from "./helpers/mock-pi.js";

const owner: OrchestrationActor = { sessionId: "session-a", runtimeId: "runtime-a", generation: 2 };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function setup(work: Array<{ prompt: string; verify?: string }>, maxAttempts = 2) {
  const { pi } = createMockPi();
  const store = new LoopStore();
  let actor = { ...owner };
  let nextAgent = 0;
  const pendingVerifies: Array<{ request: VerifyRequest; reply: ReturnType<typeof deferred<OrchestrationVerification>> }> = [];
  const runVerify = vi.fn((request: VerifyRequest) => {
    const reply = deferred<OrchestrationVerification>();
    pendingVerifies.push({ request, reply });
    return reply.promise;
  });
  const rpc = vi.fn(async (channel: string) => channel === "subagents:rpc:spawn" ? { id: `agent-${++nextAgent}` } : undefined);
  const runtime = createSubagentOrchestrationRuntime({
    events: pi.events,
    getStore: () => store,
    getScope: () => "session",
    getActor: () => actor,
    getGeneration: () => actor.generation,
    rpcCall: rpc,
    emitWake: vi.fn(),
    onExpired: vi.fn(),
    updateWidget: vi.fn(),
    now: () => 1_000,
    scheduleReconcile: (fn) => fn(),
    runVerify,
    getCwd: () => "/work/repo",
  });
  const entry = store.create({ type: "dynamic" }, "Verified batch", {
    recurring: true,
    dynamic: { goal: "Verified batch", awaitingUpdate: true },
    orchestration: { owner: actor, definition: { goal: "Verified batch", work, pacing: "aimd", maxAttempts } },
  });
  const state = () => store.get(entry.id)!.orchestration!;
  const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
  return { pi, store, runtime, runVerify, pendingVerifies, entry, state, flush, rpc, setActor(value: OrchestrationActor) { actor = value; } };
}

const pass: OrchestrationVerification = { passed: true, exitCode: 0, durationMs: 12 };
const fail: OrchestrationVerification = { passed: false, exitCode: 1, durationMs: 12, output: "expected 3, got 2" };

describe("orchestration verifier runtime", () => {
  it("holds the dispatch in flight until the verifier passes, then settles it as an ACK", async () => {
    const h = setup([{ prompt: "add sum()", verify: "node --test sum.test.js" }, { prompt: "add mul()" }]);
    await h.runtime.pump();
    expect(h.rpc.mock.calls.filter(([channel]) => channel === "subagents:rpc:spawn")).toHaveLength(1);

    h.pi.events.emit("subagents:completed", { id: "agent-1", result: "implemented sum", durationMs: 4000, tokens: { input: 50, output: 200, total: 250 } });
    await h.flush();
    expect(h.runVerify).toHaveBeenCalledTimes(1);
    expect(h.pendingVerifies[0]?.request).toMatchObject({ command: "node --test sum.test.js", cwd: "/work/repo" });
    expect(h.state().work[0]).toMatchObject({ status: "active" });
    expect(h.state().window).toMatchObject({ cwnd: 1, acks: 0 });

    h.pi.events.emit("subagents:completed", { id: "agent-1", result: "implemented sum" });
    await h.flush();
    expect(h.runVerify).toHaveBeenCalledTimes(1);

    h.pendingVerifies[0]!.reply.resolve(pass);
    await h.flush();
    expect(h.state().work[0]).toMatchObject({ status: "completed" });
    expect(h.state().work[0]?.dispatches[0]).toMatchObject({ verify: pass, usage: { durationMs: 4000 } });
    expect(h.state().window).toMatchObject({ cwnd: 2, acks: 1, minMsPerToken: 20 });
    h.runtime.dispose();
  });

  it("retries a failed verification without shrinking the window", async () => {
    const h = setup([{ prompt: "add sum()", verify: "node --test" }]);
    await h.runtime.pump();
    h.pi.events.emit("subagents:completed", { id: "agent-1", result: "done, all tests pass" });
    await h.flush();
    h.pendingVerifies[0]!.reply.resolve(fail);
    await h.flush();
    await h.runtime.pump();

    expect(h.state().window).toMatchObject({ cwnd: 1, taskLosses: 1, losses: 0 });
    expect(h.state().work[0]).toMatchObject({ status: "active", attemptCount: 2 });
    expect(h.state().work[0]?.dispatches[0]).toMatchObject({ error: "verify failed (exit 1)", verify: fail });
    h.runtime.dispose();
  });

  it("settles work without a verifier immediately", async () => {
    const h = setup([{ prompt: "summarize" }]);
    await h.runtime.pump();
    h.pi.events.emit("subagents:completed", { id: "agent-1", result: "summary" });
    await h.flush();
    expect(h.runVerify).not.toHaveBeenCalled();
    expect(h.state().work[0]).toMatchObject({ status: "completed" });
    h.runtime.dispose();
  });

  it("does not run verifiers for failed workers", async () => {
    const h = setup([{ prompt: "add sum()", verify: "node --test" }]);
    await h.runtime.pump();
    h.pi.events.emit("subagents:failed", { id: "agent-1", status: "error", error: "429 rate limited" });
    await h.flush();
    expect(h.runVerify).not.toHaveBeenCalled();
    expect(h.state().window).toMatchObject({ losses: 1 });
    h.runtime.dispose();
  });

  it("aborts in-flight verifiers on shutdown and drops their late result", async () => {
    const h = setup([{ prompt: "add sum()", verify: "node --test" }]);
    await h.runtime.pump();
    h.pi.events.emit("subagents:completed", { id: "agent-1", result: "done" });
    await h.flush();
    const signal = h.pendingVerifies[0]!.request.signal;
    h.setActor({ ...owner, generation: owner.generation + 1 });
    await h.runtime.shutdown();
    expect(signal.aborted).toBe(true);
    const afterShutdown = structuredClone(h.state());
    h.pendingVerifies[0]!.reply.resolve(pass);
    await h.flush();
    expect(h.state()).toEqual(afterShutdown);
    expect(h.state().work[0]?.dispatches[0]?.verify).toBeUndefined();
    h.runtime.dispose();
  });
});

describe("verify command runner", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-loop-verify-"));
  const run = (command: string, timeoutMs?: number, signal = new AbortController().signal) => runVerifyCommand({ command, cwd, signal, timeoutMs });

  it("passes only on exit 0 and keeps a bounded output tail", async () => {
    expect(await run("echo ok")).toMatchObject({ passed: true, exitCode: 0, output: "ok\n" });
    expect(await run("echo bad >&2; exit 3")).toMatchObject({ passed: false, exitCode: 3, output: "bad\n" });
    const long = await run("node -e \"process.stdout.write('x'.repeat(10000) + 'END')\"");
    expect(long.output?.length).toBe(2048);
    expect(long.output?.endsWith("END")).toBe(true);
  });

  it("runs in the requested cwd", async () => {
    expect((await run("pwd")).output?.trim()).toContain("pi-loop-verify-");
  });

  it("kills on timeout and abort without passing", async () => {
    expect(await run("sleep 5", 50)).toMatchObject({ passed: false, exitCode: null });
    const controller = new AbortController();
    const pending = run("sleep 5", 10_000, controller.signal);
    controller.abort();
    expect(await pending).toMatchObject({ passed: false, exitCode: null });
  });
});
