import { randomUUID } from "node:crypto";
import { RpcError, type RpcEventBus } from "../rpc/cross-extension-rpc.js";

/**
 * What orchestration needs from a worker provider, independent of any one
 * plugin's wire protocol. The provider owns worker execution and its own
 * queue; pi-loop only asks it to start and stop work and listens for outcomes.
 */
export interface SubagentLifecycleEvent {
  kind: "started" | "completed" | "failed";
  /** Provider-issued worker id, as returned by `spawn`. */
  id: string;
  result?: string;
  error?: string;
  status?: string;
  /** Optional usage: without it the delay signal and free congestion re-sends stay off. */
  toolUses?: number;
  durationMs?: number;
  tokens?: { input: number; output: number; total: number };
}

export interface SubagentSpawnRequest {
  agentType: string;
  prompt: string;
  description: string;
  model?: string;
  maxTurns?: number;
}

/** The provider replied, but not with a worker id: whether a worker started is unknown. */
export class AmbiguousSpawnReplyError extends Error {}

/**
 * The provider refused the launch for a reason that will recur on every
 * attempt (an unknown agent, invalid parameters). It says nothing about load,
 * so it must not be read as congestion.
 */
export class PermanentLaunchError extends RpcError {}

export interface SubagentProvider {
  readonly name: string;
  /** Agent type used when a work item names none. */
  readonly defaultAgentType: string;
  /** False when the provider cannot bound a worker's turns; `maxTurns` is then rejected at creation. */
  readonly supportsMaxTurns: boolean;
  /** How long a launch may take to reply before its outcome is treated as unknown. */
  readonly spawnTimeoutMs: number;
  /** False while no concrete provider has been selected; launches must wait rather than fail. */
  isAvailable(): boolean;
  /** True when a responder speaking this provider's protocol answers within the timeout. */
  probe(timeoutMs: number): Promise<boolean>;
  /** Resolves with the provider's raw reply; rejects with the transport error. */
  spawn(request: SubagentSpawnRequest, timeoutMs: number): Promise<unknown>;
  /** The worker id in a spawn reply, or undefined when the reply does not identify a worker. */
  workerId(reply: unknown): string | undefined;
  /** A resolved stop is a delivered request, never proof the worker ended. */
  stop(agentId: string, timeoutMs: number): Promise<unknown>;
  consume(agentId: string, timeoutMs: number): Promise<unknown>;
  onLifecycle(handler: (event: SubagentLifecycleEvent) => void): () => void;
  /** Fires when the provider announces its RPC is wired; a cue to probe again. */
  onReady(handler: () => void): () => void;
}

type RpcCall = (channel: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>;

const V2 = {
  ping: "subagents:rpc:ping",
  spawn: "subagents:rpc:spawn",
  stop: "subagents:rpc:stop",
  consume: "subagents:rpc:consume",
  ready: "subagents:ready",
  started: "subagents:started",
  completed: "subagents:completed",
  failed: "subagents:failed",
} as const;
const V2_PROTOCOL_VERSION = 2;

function normalizeV2Lifecycle(kind: SubagentLifecycleEvent["kind"], raw: unknown): SubagentLifecycleEvent | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const data = raw as Record<string, unknown>;
  if (typeof data.id !== "string" || data.id.length === 0) return undefined;
  const tokens = data.tokens;
  const normalizedTokens = tokens && typeof tokens === "object"
    && Number.isFinite((tokens as Record<string, unknown>).input)
    && Number.isFinite((tokens as Record<string, unknown>).output)
    && Number.isFinite((tokens as Record<string, unknown>).total)
    ? {
        input: Number((tokens as Record<string, unknown>).input),
        output: Number((tokens as Record<string, unknown>).output),
        total: Number((tokens as Record<string, unknown>).total),
      }
    : undefined;
  return {
    kind,
    id: data.id,
    result: typeof data.result === "string" ? data.result : undefined,
    error: typeof data.error === "string" ? data.error : undefined,
    status: typeof data.status === "string" ? data.status : undefined,
    toolUses: Number.isFinite(data.toolUses) ? Number(data.toolUses) : undefined,
    durationMs: Number.isFinite(data.durationMs) ? Number(data.durationMs) : undefined,
    tokens: normalizedTokens,
  };
}

/** `@tintinweb/pi-subagents` protocol v2: one event-bus channel per method. */
export function createSubagentsV2Provider(events: RpcEventBus, rpcCall: RpcCall): SubagentProvider {
  return {
    name: "@tintinweb/pi-subagents (protocol v2)",
    defaultAgentType: "general-purpose",
    supportsMaxTurns: true,
    spawnTimeoutMs: 5_000,
    isAvailable: () => true,
    async probe(timeoutMs) {
      try {
        const reply = await rpcCall(V2.ping, {}, timeoutMs);
        return !!reply && typeof reply === "object" && (reply as Record<string, unknown>).version === V2_PROTOCOL_VERSION;
      } catch {
        return false;
      }
    },
    // Not async: the caller awaits the transport promise itself, and a synchronous throw must reach its try/catch.
    spawn: (request, timeoutMs) => rpcCall(V2.spawn, {
      type: request.agentType,
      prompt: request.prompt,
      options: {
        description: request.description,
        model: request.model,
        maxTurns: request.maxTurns,
        isBackground: true,
        isolated: true,
        inheritContext: false,
      },
    }, timeoutMs),
    workerId(reply) {
      const id = reply && typeof reply === "object" ? (reply as Record<string, unknown>).id : undefined;
      return typeof id === "string" && id.length > 0 ? id : undefined;
    },
    stop: (agentId, timeoutMs) => rpcCall(V2.stop, { agentId }, timeoutMs),
    consume: (agentId, timeoutMs) => rpcCall(V2.consume, { agentId }, timeoutMs),
    onLifecycle(handler) {
      const unsubscribe = (["started", "completed", "failed"] as const).map((kind) => events.on(V2[kind], (raw) => {
        const event = normalizeV2Lifecycle(kind, raw);
        if (event) handler(event);
      }));
      return () => {
        for (const stop of unsubscribe) stop();
      };
    },
    onReady: (handler) => events.on(V2.ready, () => handler()),
  };
}

const V1 = {
  request: "subagents:rpc:v1:request",
  replyPrefix: "subagents:rpc:v1:reply:",
  ready: "subagents:rpc:v1:ready",
  started: "subagent:async-started",
  complete: "subagent:async-complete",
} as const;
const V1_PROTOCOL_VERSION = 1;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Drops undefined fields so an event carries only what the provider reported. */
function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as T;
}

/**
 * One request channel carries every method; the reply arrives on a channel
 * keyed by request id. This differs from the per-method channels of the
 * vendored RPC helper, so the envelope is handled here.
 */
function callV1(events: RpcEventBus, method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
  const requestId = randomUUID();
  const channel = `${V1.request}#${method}`;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      settle();
    };
    const timer = setTimeout(() => finish(() => reject(new RpcError(channel, `${channel} timed out after ${timeoutMs}ms`, true))), timeoutMs);
    const unsubscribe = events.on(`${V1.replyPrefix}${requestId}`, (raw) => {
      const reply = record(raw);
      if (reply?.success === true) {
        finish(() => resolve(reply.data));
        return;
      }
      const error = record(reply?.error);
      const message = text(error?.message) ?? `${channel} replied with a malformed envelope`;
      // The provider validates before it starts anything: a parameter error or an unknown agent recurs.
      const permanent = method === "spawn" && (error?.code === "invalid_params" || /^Unknown agent\b/.test(message));
      finish(() => reject(permanent ? new PermanentLaunchError(channel, message) : new RpcError(channel, message)));
    });
    try {
      events.emit(V1.request, { version: V1_PROTOCOL_VERSION, requestId, method, params });
    } catch (error) {
      finish(() => reject(error));
    }
  });
}

function normalizeV1Completion(raw: unknown): SubagentLifecycleEvent | undefined {
  const data = record(raw);
  const id = text(data?.id) ?? text(data?.runId);
  if (!data || id === undefined) return undefined;
  const first = record(Array.isArray(data.results) ? data.results[0] : undefined);
  const state = text(data.state) ?? (data.success === true ? "complete" : "failed");
  const tokens = record(data.totalTokens);
  const usage = defined({
    durationMs: Number.isFinite(data.durationMs) ? Number(data.durationMs) : undefined,
    tokens: tokens && Number.isFinite(tokens.input) && Number.isFinite(tokens.output) && Number.isFinite(tokens.total)
      ? { input: Number(tokens.input), output: Number(tokens.output), total: Number(tokens.total) }
      : undefined,
  });
  if (data.success === true && state === "complete") {
    return defined({ kind: "completed" as const, id, result: text(first?.output) ?? text(data.summary), status: state, ...usage });
  }
  // A stopped or interrupted run reports no proof the worker ended; the runtime keeps both as unconfirmed.
  if (state === "stopped") return defined({ kind: "failed" as const, id, status: "stopped", ...usage });
  if (state === "paused") return defined({ kind: "failed" as const, id, status: "aborted", ...usage });
  const reported = text(first?.error) ?? text(data.error);
  const error = data.timedOut === true
    ? `timed out: ${reported ?? "provider deadline reached"}`
    : reported ?? (state === "partial" ? "Provider reported a partial result." : undefined);
  return defined({ kind: "failed" as const, id, status: state, error, ...usage });
}

/**
 * The unscoped npm `pi-subagents` package, RPC v1. It has no per-worker turn
 * limit, no generic agent type, no consume method, and reports no tool-use
 * count, so turn bounds are rejected and delay evidence stays off. Each
 * launch is its own detached run; the run id is the worker id.
 */
export function createSubagentsV1Provider(events: RpcEventBus): SubagentProvider {
  return {
    name: "pi-subagents (RPC v1)",
    defaultAgentType: "worker",
    supportsMaxTurns: false,
    // The reply waits for the detached runner's startup handshake.
    spawnTimeoutMs: 60_000,
    isAvailable: () => true,
    async probe(timeoutMs) {
      try {
        const reply = record(await callV1(events, "ping", {}, timeoutMs));
        const methods = Array.isArray(reply?.methods) ? reply.methods : [];
        const capabilities = record(reply?.capabilities);
        return reply?.version === V1_PROTOCOL_VERSION && methods.includes("spawn") && methods.includes("stop")
          && capabilities?.asyncSpawn === true && capabilities.stop === true;
      } catch {
        return false;
      }
    },
    spawn: (request, timeoutMs) => callV1(events, "spawn", defined({
      agent: request.agentType,
      task: request.prompt,
      context: "fresh",
      model: request.model,
    }), timeoutMs),
    workerId: (reply) => text(record(record(reply)?.details)?.runId),
    stop: (agentId, timeoutMs) => callV1(events, "stop", { id: agentId }, timeoutMs),
    consume: () => Promise.reject(new Error("pi-subagents (RPC v1) does not support consume; results stay provider-owned")),
    onLifecycle(handler) {
      const unsubscribe = [
        events.on(V1.started, (raw) => {
          const id = text(record(raw)?.id);
          if (id !== undefined) handler({ kind: "started", id });
        }),
        events.on(V1.complete, (raw) => {
          const event = normalizeV1Completion(raw);
          if (event) handler(event);
        }),
      ];
      return () => {
        for (const stop of unsubscribe) stop();
      };
    },
    onReady: (handler) => events.on(V1.ready, () => handler()),
  };
}

/**
 * Picks the first provider, in order, that answers its probe, and keeps it for
 * the runtime's lifetime: persisted dispatches carry that provider's worker
 * ids, so switching mid-run could not stop or settle them. Lifecycle and
 * readiness are forwarded from every candidate; only the installed one emits.
 */
export function createSubagentProviderSelector(candidates: readonly SubagentProvider[]): SubagentProvider {
  let selected: SubagentProvider | undefined;
  const fallback = candidates[0];
  if (!fallback) throw new Error("A provider selector needs at least one candidate");
  const unavailable = () => Promise.reject(new Error("No compatible subagent provider has answered"));
  return {
    get name() { return selected?.name ?? "no subagent provider"; },
    get defaultAgentType() { return (selected ?? fallback).defaultAgentType; },
    get supportsMaxTurns() { return (selected ?? fallback).supportsMaxTurns; },
    get spawnTimeoutMs() { return (selected ?? fallback).spawnTimeoutMs; },
    isAvailable: () => selected !== undefined,
    probe(timeoutMs) {
      if (selected) return selected.probe(timeoutMs);
      // Probe together, choose by order: a candidate wins once every earlier one has answered no,
      // so an installed first choice is never held up by a later candidate's timeout.
      const answers = candidates.map((candidate) => candidate.probe(timeoutMs));
      return answers.reduce<Promise<boolean>>(async (earlier, answer, index) => {
        if (await earlier) return true;
        if (!(await answer)) return false;
        selected ??= candidates[index];
        return true;
      }, Promise.resolve(false));
    },
    spawn: (request, timeoutMs) => selected ? selected.spawn(request, timeoutMs) : unavailable(),
    workerId: (reply) => selected?.workerId(reply),
    stop: (agentId, timeoutMs) => selected ? selected.stop(agentId, timeoutMs) : unavailable(),
    consume: (agentId, timeoutMs) => selected ? selected.consume(agentId, timeoutMs) : unavailable(),
    onLifecycle(handler) {
      const unsubscribe = candidates.map((candidate) => candidate.onLifecycle(handler));
      return () => {
        for (const stop of unsubscribe) stop();
      };
    },
    onReady(handler) {
      const unsubscribe = candidates.map((candidate) => candidate.onReady(handler));
      return () => {
        for (const stop of unsubscribe) stop();
      };
    },
  };
}
