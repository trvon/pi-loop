
import { type ChildProcess, spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  type MonitorReducerEvent,
  type MonitorReducerState,
  reduceMonitorState,
} from "./monitor-reducer.js";
import type { MonitorEntry, MonitorProcess, MonitorProgress } from "./types.js";

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

const OUTPUT_EVENT_INTERVAL_MS = 1000;
const MAX_OUTPUT_LINE_LENGTH = 4096;
const OUTPUT_RATE_WINDOW_MS = 60000;
export const MONITOR_RETENTION_MS = 15 * 60 * 1000;

export class MonitorManager {
  private processes = new Map<string, MonitorProcess>();
  private nextId = 1;
  private onChange: (() => void) | undefined;
  private spawnFn: SpawnFn;

  constructor(
    private pi: ExtensionAPI,
    spawnFn?: SpawnFn,
  ) {
    this.spawnFn = spawnFn ?? ((cmd, args, opts) => nodeSpawn(cmd, args, opts));
  }

  /**
   * Register a callback fired when a monitor's status changes or it is pruned
   * (e.g. autonomous completion/error/stop/prune with no tool call). Used to
   * repaint the status widget, which otherwise only refreshes on turn
   * boundaries and explicit tool actions. Not fired for output lines.
   */
  setOnChange(cb: () => void): void {
    this.onChange = cb;
  }

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
    // Repaint on status/progress transitions, but not on frequent output-line
    // events that do not change the visible status.
    if (
      event.type !== "MONITOR_OUTPUT"
      && event.type !== "MONITOR_ONDONE_REGISTERED"
      && event.type !== "MONITOR_PROGRESS_UPDATED"
    ) {
      this.onChange?.();
    }
    return result;
  }

  // Retain terminal state long enough for a completion wake to inspect it.
  private schedulePrune(id: string): void {
    // unref so a pending prune never keeps a one-shot (`pi -p`) process alive.
    const timer = setTimeout(() => {
      this.applyReducerEvent({
        type: "MONITOR_PRUNED",
        at: Date.now(),
        source: "system",
        entityType: "monitor",
        entityId: id,
        payload: { id },
      });
    }, MONITOR_RETENTION_MS);
    timer.unref?.();
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
    const child = this.spawnFn("sh", ["-c", command], {
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
      lastOutputEventAt: 0,
      lastProgressChangeAt: 0,
      pendingOutputLines: 0,
      outputBuckets: [],
      stdoutDecoder: new StringDecoder("utf8"),
      stderrDecoder: new StringDecoder("utf8"),
      stdoutRemainder: "",
      stderrRemainder: "",
    };

    child.stdout?.on("data", (data: Buffer) => this.handleOutput(id, bp, "stdout", data));
    child.stderr?.on("data", (data: Buffer) => this.handleOutput(id, bp, "stderr", data));

    const finish = (code: number | null, status: "completed" | "error") => {
      this.flushOutput(id, bp);
      this.emitOutputProgress(id, bp);
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
      this.pi.events.emit("monitor:finished", {
        monitorId: id,
        status: current.status,
        exitCode: current.exitCode,
        outputLines: current.outputLines,
      });
      this.pi.events.emit(status === "completed" ? "monitor:done" : "monitor:error", {
        monitorId: id,
        exitCode: code,
        outputLines: current.outputLines,
      });
      for (const callback of bp.completionCallbacks) callback(current);
      bp.completionCallbacks = [];
      for (const resolve of bp.waiters) resolve();
      bp.waiters = [];
      this.schedulePrune(id);
    };

    child.on("close", (code) => {
      this.flushOutput(id, bp);
      if (bp.entry.status === "running") {
        finish(code, code === 0 ? "completed" : "error");
      }
    });

    child.on("error", (err) => {
      if (bp.entry.status === "running") {
        this.flushOutput(id, bp);
        this.emitOutputProgress(id, bp);
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
        const current = this.get(id)!;
        this.pi.events.emit("monitor:finished", {
          monitorId: id,
          status: current.status,
          error: err.message,
          outputLines: current.outputLines,
        });
        this.pi.events.emit("monitor:error", {
          monitorId: id,
          error: err.message,
        });
        for (const callback of bp.completionCallbacks) callback(current);
        bp.completionCallbacks = [];
        for (const resolve of bp.waiters) resolve();
        bp.waiters = [];
      }
    });

    if (timeout > 0) {
      setTimeout(() => {
        if (bp.entry.status === "running") {
          void this.stop(id, "timeout");
        }
      }, timeout);
    }

    this.processes.set(id, bp);
    this.pi.events.emit("monitor:started", {
      monitorId: id,
      command,
      description,
      timeout,
      timestamp: now,
    });
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

  async stop(id: string, reason: "manual" | "timeout" = "manual"): Promise<boolean> {
    const bp = this.processes.get(id);
    if (!bp || bp.entry.status !== "running") return false;

    this.emitOutputProgress(id, bp);
    this.applyReducerEvent({
      type: "MONITOR_STOPPED",
      at: Date.now(),
      source: "tool",
      entityType: "monitor",
      entityId: id,
      payload: {
        id,
        reason,
      },
    });
    this.pi.events.emit("monitor:finished", {
      monitorId: id,
      status: "stopped",
      reason,
      outputLines: bp.entry.outputLines,
    });
    this.schedulePrune(id);
    bp.proc.kill("SIGTERM");

    if (reason === "timeout") {
      this.pi.events.emit("monitor:error", {
        monitorId: id,
        error: `Timed out after ${bp.entry.timeout}ms`,
        outputLines: bp.entry.outputLines,
      });
      for (const callback of bp.completionCallbacks) callback(bp.entry);
      bp.completionCallbacks = [];
    }

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

  onComplete(id: string, callback: (monitor: MonitorEntry) => void): boolean {
    const bp = this.processes.get(id);
    if (!bp) return false;
    if (bp.entry.status === "completed" || bp.entry.status === "error") {
      callback(bp.entry);
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

  updateProgress(id: string, progress: Omit<MonitorProgress, "source" | "updatedAt">): MonitorEntry | undefined {
    const bp = this.processes.get(id);
    if (!bp || bp.entry.status !== "running") return undefined;
    this.applyProgress(id, { ...progress, source: "agent" });
    return this.get(id);
  }

  private handleOutput(id: string, bp: MonitorProcess, stream: "stdout" | "stderr", data: Buffer): void {
    const decoder = stream === "stdout" ? bp.stdoutDecoder : bp.stderrDecoder;
    const remainderKey = stream === "stdout" ? "stdoutRemainder" : "stderrRemainder";
    const records = `${bp[remainderKey]}${decoder.write(data)}`.split("\n");
    bp[remainderKey] = records.pop() ?? "";
    this.recordOutputLines(id, bp, records);
  }

  private flushOutput(id: string, bp: MonitorProcess): void {
    const stdout = `${bp.stdoutRemainder}${bp.stdoutDecoder.end()}`;
    const stderr = `${bp.stderrRemainder}${bp.stderrDecoder.end()}`;
    bp.stdoutRemainder = "";
    bp.stderrRemainder = "";
    this.recordOutputLines(id, bp, [stdout, stderr]);
  }

  private recordOutputLines(id: string, bp: MonitorProcess, records: string[]): void {
    const lines = records
      .map(line => line.endsWith("\r") ? line.slice(0, -1) : line)
      .filter(Boolean)
      .map(line => line.length <= MAX_OUTPUT_LINE_LENGTH ? line : `${line.slice(0, MAX_OUTPUT_LINE_LENGTH)}... [truncated]`);
    if (lines.length === 0) return;
    const now = Date.now();
    const second = Math.floor(now / 1000);
    const bucket = bp.outputBuckets.find(candidate => candidate.second === second);
    if (bucket) bucket.count += lines.length;
    else bp.outputBuckets.push({ second, count: lines.length });
    bp.outputBuckets = bp.outputBuckets.filter(candidate => candidate.second > second - OUTPUT_RATE_WINDOW_MS / 1000);
    const ratePerMinute = bp.outputBuckets.reduce((total, candidate) => total + candidate.count, 0);
    this.applyReducerEvent({
      type: "MONITOR_OUTPUT",
      at: now,
      source: "monitor",
      entityType: "monitor",
      entityId: id,
      payload: { id, lines, ratePerMinute },
    });
    bp.pendingOutputLines += lines.length;
    bp.latestOutputLine = lines.at(-1);
    for (const line of lines) {
      const progress = parseJsonlProgress(line);
      if (progress) this.applyProgress(id, { ...progress, source: "jsonl" });
    }
    if (Date.now() - bp.lastOutputEventAt >= OUTPUT_EVENT_INTERVAL_MS) {
      this.emitOutputProgress(id, bp);
    }
  }

  private emitOutputProgress(id: string, bp: MonitorProcess): void {
    if (!bp.latestOutputLine || bp.pendingOutputLines === 0) return;
    const current = this.get(id);
    if (!current) return;
    this.pi.events.emit("monitor:output", {
      monitorId: id,
      line: bp.latestOutputLine,
      outputLines: current.outputLines,
      droppedLines: bp.pendingOutputLines - 1,
      timestamp: Date.now(),
    });
    bp.lastOutputEventAt = Date.now();
    bp.pendingOutputLines = 0;
    bp.latestOutputLine = undefined;
  }

  private applyProgress(id: string, progress: Omit<MonitorProgress, "updatedAt">): void {
    this.applyReducerEvent({
      type: "MONITOR_PROGRESS_UPDATED",
      at: Date.now(),
      source: progress.source === "agent" ? "tool" : "monitor",
      entityType: "monitor",
      entityId: id,
      payload: { id, progress },
    });
    const bp = this.processes.get(id);
    if (bp) this.scheduleProgressChange(bp);
  }

  private scheduleProgressChange(bp: MonitorProcess): void {
    const now = Date.now();
    const delay = OUTPUT_EVENT_INTERVAL_MS - (now - bp.lastProgressChangeAt);
    if (delay <= 0) {
      bp.lastProgressChangeAt = now;
      this.onChange?.();
      return;
    }
    if (bp.progressChangeTimer) return;
    bp.progressChangeTimer = setTimeout(() => {
      bp.progressChangeTimer = undefined;
      bp.lastProgressChangeAt = Date.now();
      this.onChange?.();
    }, delay);
    bp.progressChangeTimer.unref?.();
  }
}

function parseJsonlProgress(line: string): Omit<MonitorProgress, "source" | "updatedAt"> | undefined {
  try {
    const value: unknown = JSON.parse(line);
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const progress = (value as { progress?: unknown }).progress;
    if (!progress || typeof progress !== "object" || Array.isArray(progress)) return undefined;
    const { current, total, message } = progress as Record<string, unknown>;
    if (
      (current !== undefined && (typeof current !== "number" || !Number.isFinite(current)))
      || (total !== undefined && (typeof total !== "number" || !Number.isFinite(total)))
      || (message !== undefined && typeof message !== "string")
      || (current === undefined && total === undefined && message === undefined)
    ) return undefined;
    return { current, total, message };
  } catch {
    return undefined;
  }
}
