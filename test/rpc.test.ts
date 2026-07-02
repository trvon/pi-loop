import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replyChannel } from "../src/rpc/channels.js";
import {
  handleRpc,
  PROTOCOL_VERSION,
  RpcError,
  type RpcEventBus,
  rpcCall,
  rpcProbe,
} from "../src/rpc/cross-extension-rpc.js";

/**
 * Minimal in-process bus satisfying RpcEventBus. `on` returns an
 * unsubscribe function, matching the pi.events contract the module depends on.
 */
function makeBus(): RpcEventBus {
  const handlers = new Map<string, Array<(data: unknown) => void>>();
  return {
    on(event, handler) {
      const arr = handlers.get(event) ?? [];
      arr.push(handler);
      handlers.set(event, arr);
      return () => {
        const arr2 = handlers.get(event);
        if (!arr2) return;
        const idx = arr2.indexOf(handler);
        if (idx !== -1) arr2.splice(idx, 1);
      };
    },
    emit(event, data) {
      for (const handler of (handlers.get(event) ?? []).slice()) handler(data);
    },
  };
}

/** Resolves with the payload of the next reply on a given request's reply channel. */
function waitForReply(bus: RpcEventBus, channel: string, requestId: string): Promise<unknown> {
  return new Promise((resolve) => {
    const unsub = bus.on(replyChannel(channel, requestId), (data) => {
      unsub();
      resolve(data);
    });
  });
}

describe("rpcCall", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves with the reply data on success", async () => {
    const bus = makeBus();
    const channel = "test:rpc:success";
    let seenRequest: any;
    bus.on(channel, (data) => {
      seenRequest = data;
      const req = data as { requestId: string };
      bus.emit(replyChannel(channel, req.requestId), { success: true, data: { x: 1 } });
    });

    const result = await rpcCall(bus, channel, { y: 2 });

    expect(result).toEqual({ x: 1 });
    expect(typeof seenRequest.requestId).toBe("string");
    expect(seenRequest.requestId.length).toBeGreaterThan(0);
    expect(seenRequest.y).toBe(2);
  });

  it("resolves with undefined when the success envelope carries no data", async () => {
    const bus = makeBus();
    const channel = "test:rpc:success-void";
    bus.on(channel, (data) => {
      const req = data as { requestId: string };
      bus.emit(replyChannel(channel, req.requestId), { success: true });
    });

    const result = await rpcCall(bus, channel);

    expect(result).toBeUndefined();
  });

  it("rejects with RpcError on a failure envelope", async () => {
    const bus = makeBus();
    const channel = "test:rpc:failure";
    bus.on(channel, (data) => {
      const req = data as { requestId: string };
      bus.emit(replyChannel(channel, req.requestId), { success: false, error: "nope" });
    });

    await expect(rpcCall(bus, channel)).rejects.toMatchObject({
      name: "RpcError",
      message: "nope",
      channel,
      timedOut: false,
    });
  });

  it("rejects with a timedOut RpcError after timeoutMs elapses", async () => {
    const bus = makeBus();
    const channel = "test:rpc:timeout";
    const promise = rpcCall(bus, channel, {}, 1000);
    const caught = promise.catch((error) => error);

    await vi.advanceTimersByTimeAsync(1000);
    const err = await caught;

    expect(err).toBeInstanceOf(RpcError);
    expect(err.timedOut).toBe(true);
    expect(err.channel).toBe(channel);
    expect(err.message).toMatch(/timed out/);
  });

  it("ignores a late reply that arrives after the promise already timed out", async () => {
    const bus = makeBus();
    const channel = "test:rpc:late-reply";
    let requestId = "";
    bus.on(channel, (data) => {
      requestId = (data as { requestId: string }).requestId;
    });

    const promise = rpcCall(bus, channel, {}, 1000);
    const caught = promise.catch((error) => error);

    await vi.advanceTimersByTimeAsync(1000);
    const err = await caught;
    expect(err.timedOut).toBe(true);

    // The late reply must not throw and must not re-settle the promise.
    expect(() => {
      bus.emit(replyChannel(channel, requestId), { success: true, data: { x: 99 } });
    }).not.toThrow();
    await expect(promise).rejects.toBeInstanceOf(RpcError);
  });

  it("settles once when the responder replies twice synchronously", async () => {
    const bus = makeBus();
    const channel = "test:rpc:double-reply";
    bus.on(channel, (data) => {
      const req = data as { requestId: string };
      bus.emit(replyChannel(channel, req.requestId), { success: true, data: { x: 1 } });
      bus.emit(replyChannel(channel, req.requestId), { success: true, data: { x: 2 } });
    });

    const result = await rpcCall(bus, channel);

    expect(result).toEqual({ x: 1 });
  });

  it("does not reject once the timer has been cleared by an earlier reply", async () => {
    const bus = makeBus();
    const channel = "test:rpc:clears-timer";
    bus.on(channel, (data) => {
      const req = data as { requestId: string };
      bus.emit(replyChannel(channel, req.requestId), { success: true, data: { ok: true } });
    });

    const promise = rpcCall(bus, channel, {}, 1000);
    await expect(promise).resolves.toEqual({ ok: true });

    // If clearTimeout had not fired, this would trip the (already-settled) timer path.
    await vi.advanceTimersByTimeAsync(5000);
    await expect(promise).resolves.toEqual({ ok: true });
  });

  it("rejects mentioning a malformed envelope when the reply is an empty object", async () => {
    const bus = makeBus();
    const channel = "test:rpc:malformed-empty";
    bus.on(channel, (data) => {
      const req = data as { requestId: string };
      bus.emit(replyChannel(channel, req.requestId), {});
    });

    await expect(rpcCall(bus, channel)).rejects.toThrow(/malformed envelope/);
  });

  it("rejects mentioning a malformed envelope when the reply is undefined", async () => {
    const bus = makeBus();
    const channel = "test:rpc:malformed-undefined";
    bus.on(channel, (data) => {
      const req = data as { requestId: string };
      bus.emit(replyChannel(channel, req.requestId), undefined);
    });

    await expect(rpcCall(bus, channel)).rejects.toThrow(/malformed envelope/);
  });
});

describe("rpcProbe", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves the ping reply when a responder answers", async () => {
    const bus = makeBus();
    const pingChannel = "test:rpc:ping";
    bus.on(pingChannel, (data) => {
      const req = data as { requestId: string };
      bus.emit(replyChannel(pingChannel, req.requestId), {
        success: true,
        data: { version: PROTOCOL_VERSION, provider: "test-provider" },
      });
    });

    const reply = await rpcProbe(bus, pingChannel);

    expect(reply).toEqual({ version: PROTOCOL_VERSION, provider: "test-provider" });
  });

  it("resolves undefined, never rejects, when nobody answers the ping", async () => {
    const bus = makeBus();
    const pingChannel = "test:rpc:ping-silent";

    const promise = rpcProbe(bus, pingChannel, 1000);
    await vi.advanceTimersByTimeAsync(1000);

    await expect(promise).resolves.toBeUndefined();
  });
});

describe("handleRpc", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes the raw request to fn and replies with success + data", async () => {
    const bus = makeBus();
    const channel = "test:rpc:handle-success";
    let receivedParams: any;
    const fn = vi.fn((params: any) => {
      receivedParams = params;
      return { doubled: params.a * 2 };
    });
    handleRpc(bus, channel, fn);

    const replyPromise = waitForReply(bus, channel, "r1");
    bus.emit(channel, { requestId: "r1", a: 1 });
    const reply = await replyPromise;

    expect(receivedParams).toEqual({ requestId: "r1", a: 1 });
    expect(reply).toEqual({ success: true, data: { doubled: 2 } });
  });

  it("replies with success and no data key when fn returns undefined", async () => {
    const bus = makeBus();
    const channel = "test:rpc:handle-void";
    handleRpc(bus, channel, () => undefined);

    const replyPromise = waitForReply(bus, channel, "r1");
    bus.emit(channel, { requestId: "r1" });
    const reply = await replyPromise;

    expect(reply).toEqual({ success: true });
    expect(reply as object).not.toHaveProperty("data");
  });

  it("replies with a failure envelope when fn throws synchronously", async () => {
    const bus = makeBus();
    const channel = "test:rpc:handle-throw";
    handleRpc(bus, channel, () => {
      throw new Error("bad");
    });

    const replyPromise = waitForReply(bus, channel, "r1");
    bus.emit(channel, { requestId: "r1" });
    const reply = await replyPromise;

    expect(reply).toEqual({ success: false, error: "bad" });
  });

  it("replies with a failure envelope when fn rejects", async () => {
    const bus = makeBus();
    const channel = "test:rpc:handle-reject";
    handleRpc(bus, channel, async () => {
      throw new Error("async-bad");
    });

    const replyPromise = waitForReply(bus, channel, "r1");
    bus.emit(channel, { requestId: "r1" });
    const reply = await replyPromise;

    expect(reply).toEqual({ success: false, error: "async-bad" });
  });

  it("drops the request and calls debug when requestId is missing", async () => {
    const bus = makeBus();
    const channel = "test:rpc:handle-missing-id";
    const debug = vi.fn();
    const fn = vi.fn();
    handleRpc(bus, channel, fn, { debug });

    bus.emit(channel, { a: 1 });
    await Promise.resolve();

    expect(fn).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledWith(expect.stringContaining("dropped request without requestId"));
  });

  it("drops the request when requestId is an empty string", async () => {
    const bus = makeBus();
    const channel = "test:rpc:handle-empty-id";
    const fn = vi.fn();
    handleRpc(bus, channel, fn);

    bus.emit(channel, { requestId: "" });
    await Promise.resolve();

    expect(fn).not.toHaveBeenCalled();
  });

  it("is a silent no-op when disabled", async () => {
    const bus = makeBus();
    const channel = "test:rpc:handle-disabled";
    const fn = vi.fn();
    handleRpc(bus, channel, fn, { enabled: () => false });

    const replies: unknown[] = [];
    bus.on(replyChannel(channel, "r1"), (data) => replies.push(data));
    bus.emit(channel, { requestId: "r1" });
    await Promise.resolve();

    expect(fn).not.toHaveBeenCalled();
    expect(replies).toHaveLength(0);
  });

  it("stops handling requests after the returned unsubscribe fn is called", async () => {
    const bus = makeBus();
    const channel = "test:rpc:handle-unsub";
    const fn = vi.fn(() => ({ ok: true }));
    const unsubscribe = handleRpc(bus, channel, fn);

    const firstReply = waitForReply(bus, channel, "r1");
    bus.emit(channel, { requestId: "r1" });
    await firstReply;
    expect(fn).toHaveBeenCalledTimes(1);

    unsubscribe();

    const replies: unknown[] = [];
    bus.on(replyChannel(channel, "r2"), (data) => replies.push(data));
    bus.emit(channel, { requestId: "r2" });
    await Promise.resolve();

    expect(fn).toHaveBeenCalledTimes(1);
    expect(replies).toHaveLength(0);
  });

  it("round-trips a request through handleRpc and rpcCall on the same bus", async () => {
    const bus = makeBus();
    const channel = "test:rpc:roundtrip";
    handleRpc(bus, channel, (params: { a: number; b: number }) => ({ sum: params.a + params.b }));

    const result = await rpcCall<{ sum: number }>(bus, channel, { a: 2, b: 3 });

    expect(result).toEqual({ sum: 5 });
  });
});
