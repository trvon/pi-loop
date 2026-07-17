import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";

export interface MockChildProcessOptions {
  exitCode?: number | null;
  stdout?: string[];
  stderr?: string[];
}

/**
 * Creates a mock ChildProcess for testing MonitorManager without spawning real
 * OS processes. The mock process:
 * - Emits stdout/stderr lines on the next microtask
 * - When kill() is called, emits 'close' with the configured exitCode on the
 *   next microtask (unless exitCode is null, meaning SIGKILL will be needed)
 */
export function createMockChildProcess(
  opts: MockChildProcessOptions = {},
): ChildProcess {
  const exitCode = opts.exitCode === undefined ? 0 : opts.exitCode;
  const stdoutLines = opts.stdout ?? [];
  const stderrLines = opts.stderr ?? [];

  const emitter = new EventEmitter();
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  let killed = false;

  const proc = Object.assign(emitter, {
    pid: Math.floor(Math.random() * 10000) + 1000,
    stdout,
    stderr,
    killed: false,
    kill(_signal?: string) {
      killed = true;
      this.killed = true;
      queueMicrotask(() => {
        if (exitCode !== null) {
          emitter.emit("close", exitCode);
        }
      });
      return true;
    },
  }) as unknown as ChildProcess;

  // Emit configured output on next microtask
  queueMicrotask(() => {
    for (const line of stdoutLines) {
      stdout.emit("data", Buffer.from(line + "\n"));
    }
    for (const line of stderrLines) {
      stderr.emit("data", Buffer.from(line + "\n"));
    }
    // Auto-complete short-lived processes unless exitCode is null
    if (exitCode !== null && !killed) {
      queueMicrotask(() => {
        emitter.emit("close", exitCode);
      });
    }
  });

  return proc;
}

/**
 * Convenience: create a mock spawn that returns the given processes in order.
 * Each call to the returned function pops the next process from the array.
 */
export function createSequentialSpawn(...procs: ChildProcess[]) {
  let idx = 0;
  return (_cmd: string, _args: string[], _opts: SpawnOptions): ChildProcess => {
    if (idx >= procs.length) {
      throw new Error(`mock spawn called ${idx + 1} times but only ${procs.length} processes provided`);
    }
    return procs[idx++];
  };
}
