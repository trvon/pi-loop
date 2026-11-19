import type { RpcEventBus } from "../rpc/cross-extension-rpc.js";

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

export interface SubagentProvider {
  readonly name: string;
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
