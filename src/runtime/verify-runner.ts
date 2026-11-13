import { spawn } from "node:child_process";
import type { OrchestrationVerification } from "../types.js";

export const VERIFY_TIMEOUT_MS = 300_000;
const OUTPUT_TAIL_CHARS = 2_048;

export interface VerifyRequest {
  command: string;
  cwd: string;
  signal: AbortSignal;
  timeoutMs?: number;
}

export type VerifyRunner = (request: VerifyRequest) => Promise<OrchestrationVerification>;

/**
 * Runs a work item's verifier through the user's shell. The command carries
 * the same authority as MonitorCreate: model-supplied, executed in the session
 * cwd. Only the exit status is evidence; output is a bounded tail for humans.
 */
export const runVerifyCommand: VerifyRunner = ({ command, cwd, signal, timeoutMs = VERIFY_TIMEOUT_MS }) => new Promise((resolve) => {
  const startedAt = Date.now();
  let output = "";
  let settled = false;
  const finish = (exitCode: number | null) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    signal.removeEventListener("abort", kill);
    resolve({ passed: exitCode === 0, exitCode, durationMs: Date.now() - startedAt, output: output.slice(-OUTPUT_TAIL_CHARS) || undefined });
  };
  const child = spawn(process.env.SHELL || "/bin/sh", ["-c", command], { cwd, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
  const kill = () => {
    try {
      if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch {
      // Already exited.
    }
    finish(null);
  };
  const append = (chunk: Buffer) => {
    output = (output + chunk.toString("utf8")).slice(-OUTPUT_TAIL_CHARS);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  child.on("error", (error) => {
    output = `${output}\n${error.message}`.slice(-OUTPUT_TAIL_CHARS);
    finish(null);
  });
  child.on("close", (code) => finish(code));
  const timer = setTimeout(kill, timeoutMs);
  if (signal.aborted) kill();
  else signal.addEventListener("abort", kill, { once: true });
});
