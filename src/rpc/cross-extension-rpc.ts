// VENDORED MODULE — canonical copy shared verbatim by pi-loop and pi-orca.
// If you edit this file, copy it to the sibling repo and bump VENDOR_REV.
// VENDOR_REV: 2

import { randomUUID } from "node:crypto";
import { type PingReply, replyChannel } from "./channels.js";

/**
 * Cross-extension request/reply over the in-process pi event bus.
 *
 * Wire contract (matches the pi-mono convention used by @tintinweb/pi-subagents):
 *   request:  emit(channel, { requestId, ...params })
 *   reply:    emit(`${channel}:reply:${requestId}`, RpcReply)
 */
export const PROTOCOL_VERSION = 2;

export type RpcReply<T = void> =
  | { success: true; data?: T }
  | { success: false; error: string };

export class RpcError extends Error {
  constructor(
    readonly channel: string,
    message: string,
    readonly timedOut = false,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

/** Minimal event-bus surface — satisfied by pi.events. */
export interface RpcEventBus {
  on(event: string, handler: (data: unknown) => void): () => void;
  emit(event: string, data: unknown): void;
}

/**
 * Call a remote handler and await its reply.
 *
 * Rejects with RpcError on a failure envelope or on timeout (timedOut=true).
 * Callers that treat failure as "fall back" wrap this in try/catch at the
 * layer that knows the fallback — the RPC layer itself never returns sentinels.
 */
export function rpcCall<T = void>(
  bus: RpcEventBus,
  channel: string,
  params: Record<string, unknown> = {},
  timeoutMs = 5000,
): Promise<T> {
  const requestId = randomUUID();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      unsub();
      reject(new RpcError(channel, `${channel} timed out after ${timeoutMs}ms`, true));
    }, timeoutMs);
    const unsub = bus.on(replyChannel(channel, requestId), (raw) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsub();
      const reply = raw as RpcReply<T> | undefined;
      if (reply?.success) {
        resolve(reply.data as T);
      } else {
        const error = reply && "error" in reply ? reply.error : undefined;
        reject(new RpcError(channel, error ?? `${channel} replied with a malformed envelope`));
      }
    });
    bus.emit(channel, { requestId, ...params });
  });
}

/**
 * Detection probe: resolves undefined when nobody answers the ping channel.
 * Absence of a provider is expected, not an error.
 *
 * First reply wins. If the probing extension also serves this channel, its
 * own reply will settle the probe — in that case listen on the reply channel
 * directly for the full window and filter by PingReply.provider instead.
 */
export async function rpcProbe(
  bus: RpcEventBus,
  pingChannel: string,
  timeoutMs = 5000,
): Promise<PingReply | undefined> {
  try {
    return await rpcCall<PingReply>(bus, pingChannel, {}, timeoutMs);
  } catch {
    return undefined;
  }
}

export interface HandleRpcOptions {
  /**
   * When false, the handler is a silent no-op: another extension owns the
   * channel and will reply; emitting a failure here would race its reply.
   */
  enabled?: () => boolean;
  debug?: (...args: unknown[]) => void;
}

/**
 * Register a server handler for one RPC channel. Returns the unsubscribe fn.
 *
 * Malformed requests get a failure reply, never a silent drop — the only
 * silent case is a missing requestId, which leaves no reply address.
 * A thrown/rejected fn becomes a failure envelope.
 */
export function handleRpc<P extends object, R = unknown>(
  bus: RpcEventBus,
  channel: string,
  fn: (params: P) => R | Promise<R>,
  opts?: HandleRpcOptions,
): () => void {
  return bus.on(channel, async (raw) => {
    if (opts?.enabled && !opts.enabled()) return;

    const requestId =
      raw && typeof raw === "object"
        ? (raw as { requestId?: unknown }).requestId
        : undefined;
    if (typeof requestId !== "string" || requestId.length === 0) {
      opts?.debug?.(`${channel} — dropped request without requestId`);
      return;
    }

    let reply: RpcReply<R>;
    try {
      const result = await fn(raw as P);
      reply = result === undefined ? { success: true } : { success: true, data: result };
    } catch (error) {
      reply = {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    bus.emit(replyChannel(channel, requestId), reply);
  });
}
