import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { MAX_ORCHESTRATION_VERIFY_OUTPUT_CHARS } from "../orchestration-reducer.js";
import { EXIT_CLOSE_GRACE_MS, signalProcessTree } from "../process-tree.js";
import type { OrchestrationVerification } from "../types.js";

export const VERIFY_TIMEOUT_MS = 300_000;

export interface VerifyRequest {
  command: string;
  cwd: string;
  signal: AbortSignal;
  timeoutMs?: number;
}

export type VerifyRunner = (request: VerifyRequest) => Promise<OrchestrationVerification>;

/**
 * Runs a work item's verifier through `sh`, exactly as MonitorCreate runs its
 * commands: model-supplied, in the session cwd. Only the exit status is
 * evidence; output is a bounded tail for humans and retry feedback.
 */
export const runVerifyCommand: VerifyRunner = ({ command, cwd, signal, timeoutMs = VERIFY_TIMEOUT_MS }) => new Promise((resolve) => {
  const startedAt = Date.now();
  const decoder = new StringDecoder("utf8");
  let output = "";
  let settled = false;
  let exitGrace: NodeJS.Timeout | undefined;
  let timer: NodeJS.Timeout | undefined;
  const append = (text: string) => {
    output = (output + text).slice(-MAX_ORCHESTRATION_VERIFY_OUTPUT_CHARS);
  };

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn("sh", ["-c", command], { cwd, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
  } catch (error) {
    resolve({ passed: false, exitCode: null, durationMs: 0, output: `verifier could not start: ${error instanceof Error ? error.message : String(error)}` });
    return;
  }

  const kill = () => signalProcessTree(child, "SIGKILL");
  const finish = (exitCode: number | null) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    clearTimeout(exitGrace);
    signal.removeEventListener("abort", onAbort);
    append(decoder.end());
    resolve({ passed: exitCode === 0, exitCode, durationMs: Date.now() - startedAt, output: output || undefined });
  };
  const onAbort = () => {
    kill();
    finish(null);
  };

  child.stdout?.on("data", (chunk: Buffer) => append(decoder.write(chunk)));
  child.stderr?.on("data", (chunk: Buffer) => append(decoder.write(chunk)));
  child.on("error", (error) => {
    append(`\n${error.message}`);
    finish(null);
  });
  child.on("close", (code) => finish(code));
  // A backgrounded grandchild can hold stdio open after the shell exits; the
  // shell's exit status is the verdict, and leftovers are reaped.
  child.on("exit", (code) => {
    if (settled || exitGrace) return;
    exitGrace = setTimeout(() => {
      finish(code);
      kill();
    }, EXIT_CLOSE_GRACE_MS);
    exitGrace.unref?.();
  });
  timer = setTimeout(onAbort, timeoutMs);
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
});

/**
 * Session-scoped verifier for workflow checks: every run shares one abort
 * signal so session teardown stops in-flight checks instead of letting a
 * stale command keep changing the workspace.
 */
export function createWorkflowVerifier(getCwd: () => string, runner: VerifyRunner = runVerifyCommand): {
  run: (command: string) => Promise<OrchestrationVerification>;
  abortAll: () => void;
} {
  let controller = new AbortController();
  return {
    run: (command) => runner({ command, cwd: getCwd(), signal: controller.signal }),
    abortAll: () => {
      controller.abort();
      controller = new AbortController();
    },
  };
}
