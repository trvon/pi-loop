import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { LoopEntry, MonitorEntry, Trigger } from "../types.js";
import { renderToolCall, renderToolResult, toolArg } from "../ui/tool-renderer.js";
import { displayRows, textResult } from "./tool-result.js";

interface MonitorManagerLike {
  list(): MonitorEntry[];
  create(command: string, description?: string, timeout?: number): MonitorEntry;
  stop(id: string): Promise<boolean>;
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

export function registerMonitorTools(options: MonitorToolsOptions): void {
  const { pi, getStore, getMonitorManager, updateWidget, handleMonitorDoneLoop } = options;

  pi.registerTool({
    name: "MonitorCreate",
    label: "MonitorCreate",
    renderCall: renderToolCall("Monitor", (args) => `start · ${String(toolArg(args, "description") ?? toolArg(args, "command") ?? "monitor").slice(0, 56)}`),
    renderResult: renderToolResult,
    description: `Run a shell command in the background and get notified when it finishes. The core tool for async/parallel work.

Fire off a build check, CI monitor, experiment, script, or any slow command — then keep working. Output streams back as "monitor:output" events. When the process exits, "monitor:done" fires (or "monitor:error" on failure).

If you pass onDone with a prompt, the monitor auto-creates a one-shot completion loop — you get a completion wake with the exit code and output line count. No need to poll or create a separate loop.

DO NOT use raw Bash while/sleep/for loops to watch something. DO NOT run slow commands inline that could be offloaded. Use MonitorCreate to run work in parallel while you continue.

## When to Use

Default to MonitorCreate for any long-running or background work:\n- Watch a CI/CD build (hut, gh, curl polling) while you work on something else\n- Run experiments, benchmarks, or training scripts in parallel\n- Tail a log or poll an API endpoint\n- Fire off a slow curl/fetch and check the result later\n- Run any script or command you don't need to wait on inline

## Events emitted

- "monitor:output" — { monitorId, line, timestamp } for each output line\n- "monitor:done" — { monitorId, exitCode, outputLines } on clean exit\n- "monitor:error" — { monitorId, error } on failure

## onDone — auto-notify on completion

Pass onDone with a prompt and the monitor auto-creates a one-shot loop that fires when the process exits, fails, or times out. The completion wake lets the agent inspect the final status and buffered output.\n\nExample: MonitorCreate command="python train.py" onDone="Check training results and report best loss"\nExample: MonitorCreate command="hut builds show 1769753" onDone="Analyze the build result and report status"`,
    promptGuidelines: [
      "Default to MonitorCreate for any long-running or background command — releases the agent to keep working on other tasks in parallel.",
      "When the user asks to monitor CI builds, watch a build, check a remote job, or run an experiment, use MonitorCreate instead of inline bash/curl/wait.",
      "Use onDone to auto-notify when a background command finishes — the agent will pick up the results automatically.",
    ],
    parameters: Type.Object({
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
        `Output stream: monitor:output (monitorId: ${entry.id})\n` +
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
    },
  });

  pi.registerTool({
    name: "MonitorList",
    label: "MonitorList",
    renderCall: renderToolCall("Monitor", () => "status"),
    renderResult: renderToolResult,
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
        lines.push(line);

        if (m.status !== "running" && m.outputBuffer.length > 0) {
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
    name: "MonitorStop",
    label: "MonitorStop",
    renderCall: renderToolCall("Monitor", (args) => `stop · #${String(toolArg(args, "monitorId") ?? "?")}`),
    renderResult: renderToolResult,
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
