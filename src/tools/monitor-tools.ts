import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { LoopEntry, MonitorEntry, Trigger } from "../types.js";

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

function textResult(msg: string) {
  return { content: [{ type: "text" as const, text: msg }], details: undefined as any };
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
    description: `Run a shell command in the background and get notified when it finishes. The core tool for async/parallel work.

Fire off a build check, CI monitor, experiment, script, or any slow command — then keep working. Output streams back as "monitor:output" events. When the process exits, "monitor:done" fires (or "monitor:error" on failure).

If you pass onDone with a prompt, the monitor auto-creates a one-shot completion loop — you get a completion wake with the exit code and output line count. No need to poll or create a separate loop.

DO NOT use raw Bash while/sleep/for loops to watch something. DO NOT run slow commands inline that could be offloaded. Use MonitorCreate to run work in parallel while you continue.

## When to Use

Default to MonitorCreate for any long-running or background work:\n- Watch a CI/CD build (hut, gh, curl polling) while you work on something else\n- Run experiments, benchmarks, or training scripts in parallel\n- Tail a log or poll an API endpoint\n- Fire off a slow curl/fetch and check the result later\n- Run any script or command you don't need to wait on inline

## Events emitted

- "monitor:output" — { monitorId, line, timestamp } for each output line\n- "monitor:done" — { monitorId, exitCode, outputLines } on clean exit\n- "monitor:error" — { monitorId, error } on failure

## onDone — auto-notify on completion

Pass onDone with a prompt and the monitor auto-creates a one-shot loop that fires when the process exits. The completion wake includes the exit code and output line count.\n\nExample: MonitorCreate command="python train.py" onDone="Check training results and report best loss"\nExample: MonitorCreate command="hut builds show 1769753" onDone="Analyze the build result and report status"`,
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
        return Promise.resolve(textResult("Maximum of 25 running monitors reached. Stop some before creating new ones."));
      }

      const entry = getMonitorManager().create(params.command, params.description, params.timeout);
      updateWidget();

      let onDoneMsg = "";
      if (params.onDone) {
        const doneTrigger: Trigger = { type: "event", source: "monitor:done", filter: JSON.stringify({ monitorId: entry.id }) };
        const doneLoop = getStore().create(doneTrigger, params.onDone, { recurring: false });
        handleMonitorDoneLoop(doneLoop, entry.id);
        onDoneMsg = `\nonDone loop #${doneLoop.id}: fires when monitor completes — no polling needed`;
      }

      return Promise.resolve(textResult(
        `Monitor #${entry.id} started: ${entry.command.slice(0, 60)}\n` +
        `Output stream: monitor:output (monitorId: ${entry.id})\n` +
        `Timeout: ${params.timeout ? `${params.timeout / 1000}s` : "none"}${onDoneMsg}`
      ));
    },
  });

  pi.registerTool({
    name: "MonitorList",
    label: "MonitorList",
    description: "List all monitors with their status, command, exit code, output line count, and last 5 lines of buffered output.",
    parameters: Type.Object({}),
    execute() {
      const monitors = getMonitorManager().list();
      if (monitors.length === 0) return Promise.resolve(textResult("No monitors running."));

      const lines: string[] = [];
      for (const m of monitors) {
        const icon = m.status === "running" ? ">" : m.status === "completed" ? "ok" : "!!";
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

      return Promise.resolve(textResult(lines.join("\n")));
    },
  });

  pi.registerTool({
    name: "MonitorStop",
    label: "MonitorStop",
    description: `Stop a running monitor. Sends SIGTERM, waits 5s, then SIGKILL.

Use MonitorList to find the monitor ID, then stop it with this tool.`,
    parameters: Type.Object({
      monitorId: Type.String({ description: "Monitor ID to stop" }),
    }),
    async execute(_toolCallId, params) {
      const stopped = await getMonitorManager().stop(params.monitorId);
      updateWidget();
      if (stopped) return textResult(`Monitor #${params.monitorId} stopped`);
      return textResult(`Monitor #${params.monitorId} not found or not running`);
    },
  });
}
