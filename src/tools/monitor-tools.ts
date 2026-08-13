import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { LoopEntry, MonitorEntry, MonitorProgress, Trigger } from "../types.js";
import { hideToolTranscript } from "../ui/tool-renderer.js";
import { displayRows, textResult } from "./tool-result.js";

interface MonitorManagerLike {
  list(): MonitorEntry[];
  create(command: string, description?: string, timeout?: number): MonitorEntry;
  stop(id: string): Promise<boolean>;
  updateProgress(id: string, progress: Omit<MonitorProgress, "source" | "updatedAt">): MonitorEntry | undefined;
}

interface LoopStoreLike {
  create(trigger: Trigger, prompt: string, opts: {
    recurring: boolean;
    autoTask?: boolean;
    taskBacklog?: boolean;
    readOnly?: boolean;
    maxFires?: number;
  }): LoopEntry;
}

export interface MonitorToolsOptions {
  pi: ExtensionAPI;
  getStore: () => LoopStoreLike;
  getMonitorManager: () => MonitorManagerLike;
  updateWidget: () => void;
  handleMonitorDoneLoop: (doneLoop: LoopEntry, monitorId: string) => void;
}

function formatRemaining(ms: number): string {
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
  return `${Math.round(ms / 3600000)}h`;
}

function formatActivity(monitor: MonitorEntry): string | undefined {
  const lastActivityAt = monitor.lastOutputAt ?? monitor.startedAt;
  const silence = Date.now() - lastActivityAt;
  if (silence >= 60000) return `quiet ${formatRemaining(silence)}`;
  if (monitor.outputRatePerMinute !== undefined) return `${monitor.outputRatePerMinute} lines/min`;
  return undefined;
}

export function registerMonitorTools(options: MonitorToolsOptions): void {
  const { pi, getStore, getMonitorManager, updateWidget, handleMonitorDoneLoop } = options;

  pi.registerTool({ name: "MonitorCreate", label: "MonitorCreate",
  renderShell: "self",
  renderCall: hideToolTranscript,
  renderResult: hideToolTranscript, description: `Run a long command in the background while the agent continues. Use MonitorList for status/output; do not poll with shell sleep loops.\n\nPass onDone to create one completion wake for success, failure, or timeout. The wake includes terminal status, exit code, and output count; inspect buffered output with MonitorList. Commands may emit JSONL progress as {"progress":{"current":42,"total":100,"message":"..."}}; otherwise use MonitorUpdate.`, promptGuidelines: ["Use MonitorCreate for builds, CI checks, experiments, and other commands that need not block the turn.", "Use onDone when the agent must resume automatically after completion; do not create a separate polling loop."], parameters: Type.Object({
    command: Type.String({ description: "Shell command to run in background" }),
    description: Type.Optional(Type.String({ description: "Human-readable description" })),
    timeout: Type.Optional(Type.Number({ description: "Auto-stop after N ms (default: 300000, 0 = no timeout)", default: 300000 })),
    onDone: Type.Optional(Type.String({ description: "Prompt to run when the monitor completes. Auto-creates a one-shot completion wake — no need for a separate LoopCreate." })),
  }),
  execute(_toolCallId, params) {
    if (getMonitorManager().list().filter((m) => m.status === "running").length >= 25) {
      return Promise.resolve(textResult("Maximum of 25 running monitors reached. Stop some before creating new ones.", {
        kind: "monitor", action: "create", tone: "error", summary: "Monitor limit reached", expanded: ["Stop a running monitor before starting another."],
      }));
    }
  
    const entry = getMonitorManager().create(params.command, params.description, params.timeout);
    updateWidget();
  
    let onDoneMsg = "";
    if (params.onDone) {
      // onDone delivery is callback-only: the loop below is delivered solely
      // via MonitorManager.onComplete (see handleMonitorDoneLoop →
      // monitor-ondone-runtime), so it fires exactly once by construction.
      // The event-typed trigger is metadata, NOT a live subscription — this
      // loop is deliberately NOT passed to triggerSystem.add(). The "event"
      // type lets expireEventLoops() prune it if orphaned across a session
      // and lets the widget render it as a monitor-completion wake. Do not
      // triggerSystem.add() this loop, or the monitor:done event would fire it
      // a second time.
      const doneTrigger: Trigger = { type: "event", source: "monitor:done", filter: JSON.stringify({ monitorId: entry.id }) };
      const doneLoop = getStore().create(doneTrigger, params.onDone, { recurring: false });
      handleMonitorDoneLoop(doneLoop, entry.id);
      onDoneMsg = `\nCompletion wake loop #${doneLoop.id}: fires when the monitor completes — no polling needed`;
    }
  
    return Promise.resolve(textResult(
      `Monitor #${entry.id} started: ${entry.command.slice(0, 60)}\n` +
      `Progress: MonitorList shows the live output tail; monitor:output is rate-limited (monitorId: ${entry.id})\n` +
      `Timeout: ${params.timeout ? `${params.timeout / 1000}s` : "none"}${onDoneMsg}`,
      {
        kind: "monitor",
        action: "create",
        tone: "success",
        summary: `Monitor #${entry.id} running · ${params.description ?? entry.command.slice(0, 48)}`,
        expanded: [
          `Command: ${entry.command}`,
          `Timeout: ${params.timeout ? `${params.timeout / 1000}s` : "none"}`,
          params.onDone ? "Completion wake: enabled" : "Completion wake: off",
        ],
      },
    ));
  }, });

  pi.registerTool({
    name: "MonitorList",
    label: "MonitorList",
    renderShell: "self",
    renderCall: hideToolTranscript,
    renderResult: hideToolTranscript,
    description: "List all monitors with their status, command, exit code, output line count, and last 5 lines of buffered output.",
    parameters: Type.Object({}),
    execute() {
      const monitors = getMonitorManager().list();
      if (monitors.length === 0) {
        return Promise.resolve(textResult("No monitors.", {
          kind: "monitor", action: "list", tone: "info", summary: "No monitors", expanded: ["Use MonitorCreate for long-running background work."],
        }));
      }

      const lines: string[] = [];
      for (const m of monitors) {
        const icon = m.status === "running" ? ">" : m.status === "completed" ? "ok" : "x";
        const age = Date.now() - m.startedAt;
        const ageStr = formatRemaining(age);
        let line = `${icon} #${m.id} [${m.status}] ${m.command.slice(0, 60)} — ${m.outputLines} lines (${ageStr})`;
        if (m.exitCode !== undefined) line += ` exit=${m.exitCode}`;
        if (m.progress) line += ` · ${formatProgress(m.progress)}`;
        const activity = m.status === "running" ? formatActivity(m) : undefined;
        if (activity) line += ` · ${activity}`;
        lines.push(line);

        if (m.outputBuffer.length > 0) {
          const tail = m.outputBuffer.slice(-5);
          for (const out of tail) {
            lines.push(`  | ${out.slice(0, 100)}`);
          }
        }
      }

      const running = monitors.filter((monitor) => monitor.status === "running").length;
      return Promise.resolve(textResult(lines.join("\n"), {
        kind: "monitor",
        action: "list",
        tone: "info",
        summary: `${monitors.length} monitor${monitors.length === 1 ? "" : "s"} · ${running} running`,
        expanded: displayRows(lines),
      }));
    },
  });

  pi.registerTool({
    name: "MonitorUpdate",
    label: "MonitorUpdate",
    renderShell: "self",
    renderCall: hideToolTranscript,
    renderResult: hideToolTranscript,
    description: "Set trustworthy structured progress for a running monitor that cannot emit JSONL. Pass monitorId and current/total or message. Do not use it for raw output or polling; use MonitorList.",
    parameters: Type.Object({
      monitorId: Type.String({ description: "Monitor ID to update" }),
      current: Type.Optional(Type.Number({ description: "Completed work units" })),
      total: Type.Optional(Type.Number({ description: "Total work units" })),
      message: Type.Optional(Type.String({ description: "Short progress status" })),
    }, { additionalProperties: false, minProperties: 2 }),
    execute(_toolCallId, params) {
      const entry = getMonitorManager().updateProgress(params.monitorId, {
        current: params.current,
        total: params.total,
        message: params.message,
      });
      if (!entry) {
        return Promise.resolve(textResult(`Monitor #${params.monitorId} not found or not running`, {
          kind: "monitor", action: "update", tone: "error", summary: `Monitor #${params.monitorId} unavailable`, expanded: [],
        }));
      }
      updateWidget();
      return Promise.resolve(textResult(`Monitor #${entry.id} progress updated: ${formatProgress(entry.progress!)}`, {
        kind: "monitor", action: "update", tone: "success", summary: `Monitor #${entry.id} · ${formatProgress(entry.progress!)}`, expanded: [],
      }));
    },
  });

  pi.registerTool({
    name: "MonitorStop",
    label: "MonitorStop",
    renderShell: "self",
    renderCall: hideToolTranscript,
    renderResult: hideToolTranscript,
    description: `Stop a running monitor. Sends SIGTERM, waits 5s, then SIGKILL.

Use MonitorList to find the monitor ID, then stop it with this tool.`,
    parameters: Type.Object({
      monitorId: Type.String({ description: "Monitor ID to stop" }),
    }),
    async execute(_toolCallId, params) {
      const stopped = await getMonitorManager().stop(params.monitorId);
      updateWidget();
      if (stopped) {
        return textResult(`Monitor #${params.monitorId} stopped`, {
          kind: "monitor", action: "stop", tone: "success", summary: `Monitor #${params.monitorId} stopped`, expanded: [],
        });
      }

      return textResult(`Monitor #${params.monitorId} not found or not running`, {
        kind: "monitor", action: "stop", tone: "error", summary: `Monitor #${params.monitorId} unavailable`, expanded: ["Use MonitorList to find running monitor IDs."],
      });
    },
  });
}

function formatProgress(progress: MonitorProgress): string {
  const ratio = progress.current !== undefined && progress.total !== undefined && progress.total > 0
    ? `${Math.round((progress.current / progress.total) * 100)}% (${progress.current}/${progress.total})`
    : progress.current !== undefined
      ? String(progress.current)
      : "";
  return [ratio, progress.message].filter(Boolean).join(" · ") || "updated";
}
