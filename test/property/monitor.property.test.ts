import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MonitorManager } from "../../src/monitor-manager.js";
import {
  type MonitorReducerEvent,
  type MonitorReducerState,
  reduceMonitorState,
} from "../../src/monitor-reducer.js";
import type { MonitorEntry } from "../../src/types.js";
import { createMockPi } from "../helpers/mock-pi.js";
import { propertyOptions } from "./config.js";

type ReducerCommand =
  | { type: "output"; lines: string[] }
  | { type: "complete" | "error"; exitCode: number | undefined }
  | { type: "stop"; reason: "manual" | "timeout" }
  | { type: "progress"; current: number }
  | { type: "onDone" };

const reducerCommand: fc.Arbitrary<ReducerCommand> = fc.oneof(
  fc.record({ type: fc.constant("output" as const), lines: fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 1, maxLength: 150 }) }),
  fc.record({ type: fc.constantFrom("complete" as const, "error" as const), exitCode: fc.option(fc.integer({ min: 0, max: 255 }), { nil: undefined }) }),
  fc.record({ type: fc.constant("stop" as const), reason: fc.constantFrom("manual" as const, "timeout" as const) }),
  fc.record({ type: fc.constant("progress" as const), current: fc.integer({ min: 0, max: 1_000 }) }),
  fc.record({ type: fc.constant("onDone" as const) }),
);

function reducerEventFor(command: ReducerCommand, at: number): MonitorReducerEvent {
  const base = { at, source: "system" as const };
  switch (command.type) {
    case "output":
      return { ...base, type: "MONITOR_OUTPUT", payload: { id: "1", lines: command.lines, ratePerMinute: command.lines.length } };
    case "complete":
      return { ...base, type: "MONITOR_COMPLETED", payload: { id: "1", exitCode: command.exitCode } };
    case "error":
      return { ...base, type: "MONITOR_ERRORED", payload: { id: "1", exitCode: command.exitCode } };
    case "stop":
      return { ...base, type: "MONITOR_STOPPED", payload: { id: "1", reason: command.reason } };
    case "progress":
      return { ...base, type: "MONITOR_PROGRESS_UPDATED", payload: { id: "1", progress: { current: command.current, source: "agent" } } };
    case "onDone":
      return { ...base, type: "MONITOR_ONDONE_REGISTERED", payload: { id: "1" } };
  }
}

function initialMonitorState(): MonitorReducerState {
  return reduceMonitorState(
    { nextId: 1, monitorsById: {} },
    { type: "MONITOR_CREATED", at: 0, source: "system", payload: { command: "cmd", timeout: 0 } },
  ).state;
}

describe("monitor reducer properties", () => {
  it("is deterministic, immutable, and keeps output accounting bounded and monotonic", () => {
    fc.assert(
      fc.property(fc.array(reducerCommand, { maxLength: 60 }), (commands) => {
        let state = initialMonitorState();
        let expectedLines = 0;

        commands.forEach((command, index) => {
          const event = reducerEventFor(command, index + 1);
          const snapshot = structuredClone(state);
          const first = reduceMonitorState(state, event);
          const second = reduceMonitorState(state, event);

          expect(state).toEqual(snapshot);
          expect(first).toEqual(second);
          state = first.state;
          if (command.type === "output") expectedLines += command.lines.length;

          const monitor = state.monitorsById["1"];
          expect(monitor?.outputLines).toBe(expectedLines);
          expect(monitor?.outputBuffer.length).toBeLessThanOrEqual(200);
          expect((monitor?.status === "running") === (monitor?.completedAt === undefined)).toBe(true);
        });

        expect(Object.keys(state.monitorsById)).toEqual(["1"]);
        expect(state.nextId).toBe(2);
      }),
      propertyOptions(),
    );
  });

  // The manager guards terminal transitions today; the reducer itself does not,
  // so any new caller can rewrite a recorded outcome.
  it("treats the first terminal outcome as absorbing", () => {
    fc.assert(
      fc.property(fc.array(reducerCommand, { maxLength: 60 }), (commands) => {
        let state = initialMonitorState();
        let settled: Pick<MonitorEntry, "status" | "exitCode" | "stopReason" | "completedAt"> | undefined;

        commands.forEach((command, index) => {
          state = reduceMonitorState(state, reducerEventFor(command, index + 1)).state;
          const monitor = state.monitorsById["1"];
          if (!monitor || monitor.status === "running") return;
          const outcome = {
            status: monitor.status,
            exitCode: monitor.exitCode,
            stopReason: monitor.stopReason,
            completedAt: monitor.completedAt,
          };
          settled ??= outcome;
          expect(outcome).toEqual(settled);
        });
      }),
      propertyOptions(),
    );
  });

  it("treats generated missing IDs as identity no-ops", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 1_000 }), reducerCommand, (missingId, command) => {
        const state = initialMonitorState();
        const event = reducerEventFor(command, 1);
        event.payload = { ...event.payload, id: String(missingId) } as typeof event.payload;
        const result = reduceMonitorState(state, event);

        expect(result.state).toBe(state);
        expect(result.effects).toEqual([]);
      }),
      propertyOptions(),
    );
  });
});

type LifecycleAction =
  | "stdout"
  | "stderr"
  | "closeOk"
  | "closeFail"
  | "closeSignal"
  | "error"
  | "stop"
  | "onComplete"
  | "onTerminal";

const lifecycleAction = fc.constantFrom<LifecycleAction>(
  "stdout",
  "stderr",
  "closeOk",
  "closeFail",
  "closeSignal",
  "error",
  "stop",
  "onComplete",
  "onTerminal",
);

// pid is left undefined so group signalling falls back to the mock's kill()
// instead of signalling a real process group.
function createControllableChild() {
  const emitter = new EventEmitter();
  let closed = false;
  const close = (code: number | null, signal: string | null = null) => {
    if (closed) return;
    closed = true;
    emitter.emit("close", code, signal);
  };
  const child = Object.assign(emitter, {
    pid: undefined,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill() {
      queueMicrotask(() => close(null, "SIGTERM"));
      return true;
    },
  }) as unknown as ChildProcess;
  return { child, close, isClosed: () => closed };
}

async function settleMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("monitor manager lifecycle properties", () => {
  it("settles once, never rewrites the outcome, and never strands a registered callback", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(lifecycleAction, { maxLength: 25 }), async (actions) => {
        const { pi, emittedEvents } = createMockPi();
        const { child, close, isClosed } = createControllableChild();
        const manager = new MonitorManager(pi, () => child);
        const entry = manager.create("cmd", "property", 0);
        const completions: Array<{ calls: number }> = [];
        const terminals: Array<{ calls: number }> = [];
        const stops: Array<Promise<boolean>> = [];
        let settledStatus: MonitorEntry["status"] | undefined;
        let reaped = false;

        for (const action of actions) {
          switch (action) {
            case "stdout":
              child.stdout?.emit("data", Buffer.from("line\n"));
              break;
            case "stderr":
              child.stderr?.emit("data", Buffer.from("warn\n"));
              break;
            case "closeOk":
              close(0);
              break;
            case "closeFail":
              close(1);
              break;
            case "closeSignal":
              close(null, "SIGKILL");
              break;
            case "error":
              child.emit("error", new Error("spawn failed"));
              reaped = true;
              break;
            case "stop":
              stops.push(manager.stop(entry.id));
              break;
            case "onComplete": {
              const record = { calls: 0 };
              if (manager.onComplete(entry.id, () => { record.calls++; })) completions.push(record);
              break;
            }
            case "onTerminal": {
              const record = { calls: 0 };
              if (manager.onTerminal(entry.id, () => { record.calls++; })) terminals.push(record);
              break;
            }
          }
          await settleMicrotasks();

          const status = manager.get(entry.id)?.status;
          if (status !== "running") settledStatus ??= status;
          if (settledStatus) expect(status).toBe(settledStatus);
          for (const record of [...completions, ...terminals]) expect(record.calls).toBeLessThanOrEqual(1);
        }

        await Promise.all(stops);
        const finished = emittedEvents.filter((event) => event.name === "monitor:finished");
        expect(finished).toHaveLength(settledStatus ? 1 : 0);
        if (settledStatus === "completed" || settledStatus === "error") {
          for (const record of completions) expect(record.calls).toBe(1);
        }
        if (settledStatus && (reaped || isClosed())) {
          for (const record of terminals) expect(record.calls).toBe(1);
        }

        if (!settledStatus) await manager.stop(entry.id);
      }),
      propertyOptions(),
    );
  });
});
