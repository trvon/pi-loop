
import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  type MonitorReducerEvent,
  type MonitorReducerState,
  reduceMonitorState,
} from "./monitor-reducer.js";
import type { MonitorEntry, MonitorProcess } from "./types.js";

export class MonitorManager {
  private processes = new Map<string, MonitorProcess>();
  private nextId = 1;

  constructor(private pi: ExtensionAPI) {}

  private toReducerState(): MonitorReducerState {
    return {
      nextId: this.nextId,
      monitorsById: Object.fromEntries(
        Array.from(this.processes.entries()).map(([id, process]) => [id, process.entry]),
      ),
    };
  }

  private applyReducerEvent(event: MonitorReducerEvent) {
    const result = reduceMonitorState(this.toReducerState(), event);
    this.nextId = result.state.nextId;
    for (const [id, process] of [...this.processes.entries()]) {
      const updated = result.state.monitorsById[id];
      if (!updated) {
        this.processes.delete(id);
        continue;
      }
      process.entry = updated;
    }
    return result;
  }

  create(command: string, description?: string, timeout = 300000): MonitorEntry {
    const now = Date.now();
    const result = reduceMonitorState(this.toReducerState(), {
      type: "MONITOR_CREATED",
      at: now,
      source: "tool",
      entityType: "monitor",
      payload: {
        command,
        description,
        timeout,
      },
    });
    this.nextId = result.state.nextId;
    const id = String(this.nextId - 1);
    const entry = result.state.monitorsById[id]!;

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
      completionCallbacks: [],
    };

    child.stdout?.on("data", (data: Buffer) => {
      const lines = data.toString().split("\n");
      for (const line of lines) {
        if (line.length === 0) continue;
        this.applyReducerEvent({
          type: "MONITOR_OUTPUT",
          at: Date.now(),
          source: "monitor",
          entityType: "monitor",
          entityId: id,
          payload: { id, line },
        });
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
        this.applyReducerEvent({
          type: "MONITOR_OUTPUT",
          at: Date.now(),
          source: "monitor",
          entityType: "monitor",
          entityId: id,
          payload: { id, line },
        });
        this.pi.events.emit("monitor:output", {
          monitorId: id,
          line,
          timestamp: Date.now(),
        });
      }
    });

    const finish = (code: number | null, status: "completed" | "error") => {
      this.applyReducerEvent({
        type: status === "completed" ? "MONITOR_COMPLETED" : "MONITOR_ERRORED",
        at: Date.now(),
        source: "monitor",
        entityType: "monitor",
        entityId: id,
        payload: {
          id,
          exitCode: code ?? undefined,
        },
      });
      const current = this.get(id)!;
      this.pi.events.emit(status === "completed" ? "monitor:done" : "monitor:error", {
        monitorId: id,
        exitCode: code,
        outputLines: current.outputLines,
      });
      if (status === "completed") {
        for (const callback of bp.completionCallbacks) callback();
      }
      bp.completionCallbacks = [];
      for (const resolve of bp.waiters) resolve();
      bp.waiters = [];
      // Remove completed/errored monitors after a brief delay so tool
      // consumers have time to read the final state via MonitorList.
      setTimeout(() => {
        this.applyReducerEvent({
          type: "MONITOR_PRUNED",
          at: Date.now(),
          source: "system",
          entityType: "monitor",
          entityId: id,
          payload: { id },
        });
      }, 30000);
    };

    child.on("close", (code) => {
      if (bp.entry.status === "running") {
        finish(code, code === 0 ? "completed" : "error");
      }
    });

    child.on("error", (err) => {
      if (bp.entry.status === "running") {
        this.applyReducerEvent({
          type: "MONITOR_ERRORED",
          at: Date.now(),
          source: "monitor",
          entityType: "monitor",
          entityId: id,
          payload: {
            id,
            error: err.message,
          },
        });
        this.pi.events.emit("monitor:error", {
          monitorId: id,
          error: err.message,
        });
        bp.completionCallbacks = [];
        for (const resolve of bp.waiters) resolve();
        bp.waiters = [];
      }
    });

    if (timeout > 0) {
      setTimeout(() => {
        if (bp.entry.status === "running") {
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

    this.applyReducerEvent({
      type: "MONITOR_STOPPED",
      at: Date.now(),
      source: "tool",
      entityType: "monitor",
      entityId: id,
      payload: {
        id,
        reason: "manual",
      },
    });
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

    bp.completionCallbacks = [];
    for (const resolve of bp.waiters) resolve();
    bp.waiters = [];
    return true;
  }

  onComplete(id: string, callback: () => void): boolean {
    const bp = this.processes.get(id);
    if (!bp) return false;
    if (bp.entry.status === "completed") {
      callback();
      return true;
    }
    if (bp.entry.status !== "running") return false;
    this.applyReducerEvent({
      type: "MONITOR_ONDONE_REGISTERED",
      at: Date.now(),
      source: "tool",
      entityType: "monitor",
      entityId: id,
      payload: { id },
    });
    bp.completionCallbacks.push(callback);
    return true;
  }

  getProcess(id: string): MonitorProcess | undefined {
    return this.processes.get(id);
  }
}
