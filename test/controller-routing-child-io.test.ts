import { describe, expect, it, vi } from "vitest";
import { sendRpcPrompt } from "./e2e/rpc-child-io.mjs";

type ErrorListener = (cause: Error) => void;

class FailingStdin {
  destroyed = false;
  writable = true;
  private readonly listeners = new Set<ErrorListener>();

  once(event: "error", listener: ErrorListener): void {
    if (event === "error") this.listeners.add(listener);
  }

  off(event: "error", listener: ErrorListener): void {
    if (event === "error") this.listeners.delete(listener);
  }

  write(_payload: string, callback?: (error?: Error) => void): boolean {
    const error = new Error("write EPIPE");
    for (const listener of this.listeners) {
      this.listeners.delete(listener);
      listener(error);
    }
    callback?.(error);
    return false;
  }
}

describe("routing harness child I/O", () => {
  it("reports a stdin EPIPE once instead of throwing an unhandled error", () => {
    const stdin = new FailingStdin();
    const onError = vi.fn();

    expect(() => sendRpcPrompt({ stdin }, "routing-test", "create tasks", onError)).not.toThrow();

    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]?.[0]).toMatchObject({ message: "write EPIPE" });
  });

  it("reports an already-closed stdin without attempting a write", () => {
    const stdin = new FailingStdin();
    stdin.destroyed = true;
    const write = vi.spyOn(stdin, "write");
    const onError = vi.fn();

    sendRpcPrompt({ stdin }, "routing-test", "create tasks", onError);

    expect(write).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]?.[0]).toMatchObject({ message: "pi stdin is not writable" });
  });
});
