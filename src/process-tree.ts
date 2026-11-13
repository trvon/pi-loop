import { type ChildProcess, spawn as nodeSpawn, type SpawnOptions } from "node:child_process";

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

/** `close` waits for every inherited stdio handle; after `exit`, wait this long before settling anyway. */
export const EXIT_CLOSE_GRACE_MS = 2000;

export interface ProcessTreeOptions {
  platform?: NodeJS.Platform;
  taskkillSpawn?: SpawnFn;
}

/**
 * Signal a shell and everything it started. POSIX children are spawned
 * detached so the negative pid addresses their process group; Windows uses
 * `taskkill /t`. Falls back to signalling the direct child.
 */
export function signalProcessTree(proc: ChildProcess, signal: NodeJS.Signals, options: ProcessTreeOptions = {}): void {
  const platform = options.platform ?? process.platform;
  const pid = proc.pid;
  let fellBack = false;
  const fallback = () => {
    if (fellBack) return;
    fellBack = true;
    try { proc.kill(signal); } catch { /* already dead */ }
  };
  if (platform === "win32") {
    try {
      const taskkill = (options.taskkillSpawn ?? nodeSpawn)("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
      taskkill.once("error", fallback);
      taskkill.once("close", (code) => {
        if (code !== 0) fallback();
      });
    } catch {
      fallback();
    }
    return;
  }

  try {
    process.kill(-Number(pid), signal);
  } catch {
    fallback();
  }
}
