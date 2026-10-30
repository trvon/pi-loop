import { describe, expect, it } from "vitest";
import { createToolObserver } from "../benchmarks/native-tool-observer.js";

const start = (id = "1", args: unknown = {}) => ({ type: "tool_execution_start" as const, toolCallId: id, toolName: "TaskCreate", args });
const end = (id = "1") => ({ type: "tool_execution_end" as const, toolCallId: id, toolName: "TaskCreate", isError: false, result: { content: [{ type: "text", text: "Created" }] } });

describe("bounded native execution evidence", () => {
  it("rejects invalid observation limits before collecting execution data", () => {
    for (const limits of [{ calls: 0, bytes: 1 }, { calls: 1, bytes: 0 }, { calls: Infinity, bytes: 1 }, { calls: 1, bytes: 0.5 }]) {
      expect(() => createToolObserver(limits)).toThrow(RangeError);
    }
  });

  it("requires matching final results and returns detached snapshots", () => {
    const observer = createToolObserver();
    observer.agentStart();
    const event = start("1", { subject: "Original" });
    observer.start(event);
    event.args = { subject: "Changed after start" };
    expect(observer.snapshot().complete).toBe(false);
    observer.end(end());
    const snapshot = observer.snapshot();
    expect(snapshot.complete).toBe(true);
    expect(snapshot.calls[0]?.args).toEqual({ subject: "Original" });
    snapshot.calls.length = 0;
    expect(observer.snapshot().calls).toHaveLength(1);
  });

  it("marks overflow and unserializable evidence incomplete without throwing inside execution hooks", () => {
    const count = createToolObserver({ calls: 1, bytes: 4096 });
    count.agentStart();
    count.start(start()); count.end(end()); count.start(start("2"));
    expect(count.snapshot()).toMatchObject({ complete: false, reasons: ["Tool evidence call limit exceeded"] });
    expect(count.snapshot().calls).toHaveLength(1);
    const bytes = createToolObserver({ calls: 10, bytes: 1 });
    expect(() => bytes.start(start())).not.toThrow();
    expect(bytes.snapshot()).toMatchObject({ complete: false, calls: [], reasons: ["Tool evidence byte limit exceeded"] });
    const invalid = createToolObserver();
    expect(() => invalid.start(start("1", 1n))).not.toThrow();
    expect(invalid.snapshot()).toMatchObject({ complete: false, reasons: ["Tool evidence could not be serialized"] });
  });

  it("rejects unmatched, duplicate and identity-mismatched events and extension errors", () => {
    for (const mutate of [
      (observer: ReturnType<typeof createToolObserver>) => observer.end(end("absent")),
      (observer: ReturnType<typeof createToolObserver>) => observer.start(start()),
      (observer: ReturnType<typeof createToolObserver>) => observer.end({ ...end(), toolName: "LoopCreate" }),
      (observer: ReturnType<typeof createToolObserver>) => observer.end({ ...end(), parentToolCallId: "absent" }),
      (observer: ReturnType<typeof createToolObserver>) => observer.incomplete("Extension error"),
    ]) {
      const observer = createToolObserver();
      observer.agentStart(); observer.start(start()); mutate(observer); observer.end(end());
      expect(observer.snapshot().complete).toBe(false);
      expect(observer.snapshot().reasons.length).toBeGreaterThan(0);
    }
    const duplicate = createToolObserver();
    duplicate.agentStart(); duplicate.start(start()); duplicate.end(end()); duplicate.end(end());
    expect(duplicate.snapshot().complete).toBe(false);
  });
});
