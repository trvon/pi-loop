
import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MonitorEntry, MonitorProcess } from "./types.js";

export class MonitorManager {
  private processes = new Map<string, MonitorProcess>();
  private nextId = 1;

  constructor(private pi: ExtensionAPI) {}

  create(command: string, description?: string, timeout = 300000): MonitorEntry {
    const id = String(this.nextId++);
    const entry: MonitorEntry = {
      id,
      command,
      description,
      timeout,
      status: "running",
      startedAt: Date.now(),
      outputLines: 0,
      outputBuffer: [],
    };

    const abortController = new AbortController();
    const child = spawn("sh", ["-c", command], {
      stdio: ["ignore", "pipe", "pipe"],
      signal: abortController.signal,
      env: { ...process.env },
    });

    const bp: MonitorProcess = {
      entry,
      pid: child.pid!,
      proc: child,
      abortController,
      waiters: [],
    };

    child.stdout?.on("data", (data: Buffer) => {
      const lines = data.toString().split("\n");
      for (const line of lines) {
        if (line.length === 0) continue;
        entry.outputLines++;
        if (entry.outputBuffer.length < 200) entry.outputBuffer.push(line);
        this.pi.events.emit("monitor:output", {
          monitorId: id,
          line,
          timestamp: Date.now(),
        });
      }
    });

    child.stderr?.on("data", (data: Buffer) => {
      const lines = data.toString().split("\n");
      for (const line of lines) {
        if (line.length === 0) continue;
        entry.outputLines++;
        if (entry.outputBuffer.length < 200) entry.outputBuffer.push(line);
        this.pi.events.emit("monitor:output", {
          monitorId: id,
          line,
          timestamp: Date.now(),
        });
      }
    });

    const finish = (code: number | null, status: "completed" | "error") => {
      entry.status = status;
      entry.exitCode = code ?? undefined;
      entry.completedAt = Date.now();
      this.pi.events.emit(status === "completed" ? "monitor:done" : "monitor:error", {
        monitorId: id,
        exitCode: code,
        outputLines: entry.outputLines,
      });
      for (const resolve of bp.waiters) resolve();
      bp.waiters = [];
      // Remove completed/errored monitors after a brief delay so tool
      // consumers have time to read the final state via MonitorList.
      setTimeout(() => { this.processes.delete(id); }, 30000);
    };

    child.on("close", (code) => {
      if (entry.status === "running") {
        finish(code, code === 0 ? "completed" : "error");
      }
    });

    child.on("error", (err) => {
      if (entry.status === "running") {
        entry.status = "error";
        entry.completedAt = Date.now();
        this.pi.events.emit("monitor:error", {
          monitorId: id,
          error: err.message,
        });
        for (const resolve of bp.waiters) resolve();
        bp.waiters = [];
      }
    });

    if (timeout > 0) {
      setTimeout(() => {
        if (entry.status === "running") {
          this.stop(id);
        }
      }, timeout);
    }

    this.processes.set(id, bp);
    return entry;
  }

  get(id: string): MonitorEntry | undefined {
    const bp = this.processes.get(id);
    return bp?.entry;
  }

  list(): MonitorEntry[] {
    return Array.from(this.processes.values())
      .map(bp => bp.entry)
      .sort((a, b) => Number(a.id) - Number(b.id));
  }

  async stop(id: string): Promise<boolean> {
    const bp = this.processes.get(id);
    if (!bp || bp.entry.status !== "running") return false;

    bp.entry.status = "stopped";
    bp.proc.kill("SIGTERM");

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try { bp.proc.kill("SIGKILL"); } catch { /* already dead */ }
        resolve();
      }, 5000);

      bp.proc.on("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });

    bp.entry.completedAt = Date.now();
    for (const resolve of bp.waiters) resolve();
    bp.waiters = [];
    return true;
  }

  getProcess(id: string): MonitorProcess | undefined {
    return this.processes.get(id);
  }
}
