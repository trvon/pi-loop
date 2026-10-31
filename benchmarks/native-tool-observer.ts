import type { ToolExecutionEndEvent, ToolExecutionStartEvent } from "@earendil-works/pi-coding-agent";

export interface ObservedToolCall {
  toolCallId: string;
  name: string;
  parentToolCallId?: string;
  args: unknown;
  agentRun: number;
  result?: unknown;
  isError?: boolean;
}

export function createToolObserver(limits = { calls: 64, bytes: 2 * 1024 * 1024 }) {
  if (!Number.isSafeInteger(limits.calls) || limits.calls < 1 || !Number.isSafeInteger(limits.bytes) || limits.bytes < 1) {
    throw new RangeError("Tool observation limits must be positive safe integers");
  }
  const calls = new Map<string, ObservedToolCall>();
  const reasons: string[] = [];
  let bytes = 0;
  let agentRuns = 0;
  function incomplete(reason: string) {
    if (reasons.length < 8 && !reasons.includes(reason)) reasons.push(reason);
  }
  function snapshotValue<T>(value: T): { value: T } | null {
    try {
      const json = JSON.stringify(value);
      const size = Buffer.byteLength(json);
      if (bytes + size > limits.bytes) {
        incomplete("Tool evidence byte limit exceeded");
        return null;
      }
      bytes += size;
      return { value: JSON.parse(json) };
    } catch {
      incomplete("Tool evidence could not be serialized");
      return null;
    }
  }
  return {
    incomplete,
    hasFailures() { return reasons.length > 0; },
    agentStart() { agentRuns++; },
    start(event: ToolExecutionStartEvent) {
      if (calls.has(event.toolCallId)) { incomplete("Duplicate tool start"); return; }
      if (calls.size >= limits.calls) { incomplete("Tool evidence call limit exceeded"); return; }
      if (event.parentToolCallId && !calls.has(event.parentToolCallId)) incomplete("Missing parent tool start");
      const data = snapshotValue({
        toolCallId: event.toolCallId, name: event.toolName, args: event.args,
        ...(event.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {}), agentRun: agentRuns,
      });
      if (data) calls.set(event.toolCallId, data.value);
    },
    end(event: ToolExecutionEndEvent) {
      const call = calls.get(event.toolCallId);
      if (!call) { incomplete("Tool end without retained start"); return; }
      if (call.isError !== undefined) { incomplete("Duplicate tool end"); return; }
      if (call.name !== event.toolName || call.parentToolCallId !== event.parentToolCallId) {
        incomplete("Tool end identity mismatch");
        return;
      }
      const data = snapshotValue({ result: event.result, isError: event.isError });
      if (data) Object.assign(call, data.value);
    },
    snapshot() {
      const observed = [...calls.values()];
      const pending = observed.some(call => call.isError === undefined || call.result === undefined);
      return structuredClone({
        complete: agentRuns > 0 && reasons.length === 0 && !pending,
        reasons: pending ? [...reasons, "Unfinished tool executions"] : reasons, agentRuns, bytes, calls: observed,
      });
    },
  };
}
