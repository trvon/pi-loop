import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { formatTrigger } from "../loop-format.js";
import { isValidCronExpression, parseInterval } from "../loop-parse.js";
import type { OrchestrationCancellation } from "../runtime/subagent-orchestration-runtime.js";
import type { DynamicLoopState, LoopEntry, Trigger } from "../types.js";
import { formatOrchestrationInspection, orchestrationCancellationMessage, orchestrationProgressLabel, orchestrationStatusLabel } from "../ui/orchestration-presentation.js";
import { formatWorkflowInspection, workflowActivityLabel } from "../ui/workflow-presentation.js";
import { isTerminalWorkflowRun } from "../workflow-reducer.js";

interface LoopStoreLike {
  list(): LoopEntry[];
  get(id: string): LoopEntry | undefined;
  create(trigger: Trigger, prompt: string, options: {
    recurring: boolean;
    autoTask?: boolean;
    taskBacklog?: boolean;
    readOnly?: boolean;
    maxFires?: number;
    expiresIn?: string;
    dynamic?: Partial<DynamicLoopState>;
  }): LoopEntry;
  pause(id: string): LoopEntry | undefined;
  resume(id: string): LoopEntry | undefined;
  delete(id: string): boolean;
}

interface TriggerSystemLike {
  add(entry: LoopEntry): void;
  remove(id: string): void;
}

export interface LoopCommandOptions {
  pi: ExtensionAPI;
  getStore: () => LoopStoreLike;
  getTriggerSystem: () => TriggerSystemLike;
  updateWidget: () => void;
  maybeBootstrapTaskLoop?: (entry: LoopEntry) => Promise<boolean>;
  onDynamicLoopActivated?: (entry: LoopEntry) => void;
  cancelOrchestration?: (id: string, action: "pause" | "delete") => Promise<OrchestrationCancellation>;
}

type LoopCommandRoute =
  | { type: "menu" }
  | { type: "event"; source: string; prompt: string }
  | { type: "cron"; interval: string; prompt: string; notifyEvery: boolean }
  | { type: "invalid-cron"; interval: string }
  | { type: "missing-interval-prompt" }
  | { type: "dynamic"; goal: string };

function extractExpiryOverride(input: string): { args: string; expiresIn?: string; error?: string } {
  const trimmed = input.trim();
  if (!trimmed.startsWith("--expires-in")) return { args: trimmed };
  const match = trimmed.match(/^--expires-in\s+(\S+)(?:\s+(.*))?$/s);
  if (!match?.[1]) return { args: "", error: "--expires-in requires a duration such as 12h or 14d." };
  return { args: match[2]?.trim() ?? "", expiresIn: match[1] };
}

function parseLoopCommandRoute(input: string): LoopCommandRoute {
  const trimmed = input.trim();
  if (!trimmed) return { type: "menu" };

  const eventMatch = trimmed.match(/^(?:event|when)\s+(\S+)\s+(.+)$/i);
  if (eventMatch?.[1] && eventMatch[2]) {
    return { type: "event", source: eventMatch[1], prompt: eventMatch[2].trim() };
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length > 5) {
    const interval = parts.slice(0, 5).join(" ");
    const cronShaped = parts.slice(0, 5).every((part) => /^[\d*/,-]+$/.test(part));
    if (cronShaped) {
      if (!isValidCronExpression(interval)) return { type: "invalid-cron", interval };
      return { type: "cron", interval, prompt: parts.slice(5).join(" "), notifyEvery: false };
    }
  }

  const intervalMatch = trimmed.match(/^(\d+\s*[smhdS]\b)/i);
  if (intervalMatch) {
    const interval = intervalMatch[1] ?? intervalMatch[0];
    const prompt = trimmed.slice(intervalMatch[0].length).trim();
    if (!prompt) return { type: "missing-interval-prompt" };
    return { type: "cron", interval, prompt, notifyEvery: true };
  }

  return { type: "dynamic", goal: trimmed };
}

export function registerLoopCommand(options: LoopCommandOptions): void {
  const { pi, getStore, getTriggerSystem, updateWidget, maybeBootstrapTaskLoop, onDynamicLoopActivated, cancelOrchestration } = options;

  function createCronLoop(ui: ExtensionUIContext, interval: string, prompt: string, notifyEvery: boolean, expiresIn?: string) {
    let entry: LoopEntry | undefined;
    try {
      const parsed = parseInterval(interval);
      const trigger: Trigger = { type: "cron", schedule: parsed.cron };
      entry = getStore().create(trigger, prompt, { recurring: true, expiresIn });
      getTriggerSystem().add(entry);
      updateWidget();
      const cadence = notifyEvery ? `every ${parsed.description}` : parsed.description;
      ui.notify(`Loop #${entry.id} created: ${cadence} — ${prompt.slice(0, 50)}`, "info");
    } catch (err: unknown) {
      if (entry) {
        getTriggerSystem().remove(entry.id);
        getStore().delete(entry.id);
        updateWidget();
      }
      ui.notify((err as Error).message, "error");
    }
  }

  async function scheduleLoop(ui: ExtensionUIContext, prompt?: string, expiresIn?: string) {
    const p = prompt || await ui.input("Prompt (what should the agent check?)");
    if (!p) return;

    const interval = await ui.input("Interval (e.g., 5m, 2h, 1d)");
    if (!interval) return;

    createCronLoop(ui, interval, p, true, expiresIn);
  }

  async function eventLoop(ui: ExtensionUIContext, prompt?: string, sourceOverride?: string, expiresIn?: string) {
    const p = prompt || await ui.input("Prompt");
    if (!p) return;

    const source = sourceOverride || await ui.input("Pi event source (e.g., tool_execution_start, before_agent_start)");
    if (!source) return;

    const trigger: Trigger = { type: "event", source };
    const taskBacklog = source === "tasks:created";
    let entry: LoopEntry;
    try {
      entry = getStore().create(trigger, p, {
        recurring: true,
        taskBacklog,
        maxFires: taskBacklog ? 25 : undefined,
        expiresIn,
      });
    } catch (error) {
      ui.notify(error instanceof Error ? error.message : String(error), "error");
      return;
    }
    getTriggerSystem().add(entry);
    updateWidget();
    const bootstrapped = taskBacklog ? await maybeBootstrapTaskLoop?.(entry) : false;
    const adoption = taskBacklog
      ? `; adopts unfinished tasks${bootstrapped ? " (initial wake queued)" : ""}`
      : "";
    ui.notify(`Event loop #${entry.id} created: fires on "${source}"${adoption}`, "info");
  }

  function dynamicLoop(ui: ExtensionUIContext, goal: string, expiresIn?: string) {
    const trigger: Trigger = { type: "dynamic" };
    let entry: LoopEntry;
    try {
      entry = getStore().create(trigger, goal, {
        recurring: true,
        expiresIn,
        dynamic: { goal, iteration: 0 },
      });
    } catch (error) {
      ui.notify(error instanceof Error ? error.message : String(error), "error");
      return;
    }
    getTriggerSystem().add(entry);
    updateWidget();
    ui.notify(`Dynamic loop #${entry.id} created — ${goal.slice(0, 50)}`, "info");
    onDynamicLoopActivated?.(entry);
  }

  async function viewLoops(ui: ExtensionUIContext) {
    const loops = getStore().list();
    if (loops.length === 0) {
      await ui.select("No loops configured", ["< Back"]);
      return;
    }

    const now = Date.now();
    const choices = loops.map((l) => {
      const icon = l.status === "active" ? "*" : l.status === "paused" ? "-" : "x";
      const activity = l.workflow ? ` [activity:${workflowActivityLabel(l, now)}]` : "";
      const orchestration = l.orchestration
        ? ` [${orchestrationStatusLabel(l.orchestration.status)}: ${orchestrationProgressLabel(l.orchestration)}]`
        : "";
      return `${icon} #${l.id} [${l.status}] ${l.prompt.slice(0, 50)}${activity}${orchestration} (${formatTrigger(l.trigger, "command")})`;
    });
    choices.push("< Back");

    const selected = await ui.select("Loops", choices);
    if (!selected || selected === "< Back") return;

    const match = selected.match(/#(\d+)/);
    if (match?.[1]) {
      const entry = getStore().get(match[1]);
      if (entry) {
        const actions = ["x Delete"];
        if (entry.status === "active") actions.unshift("- Pause");
        else if (
          entry.status === "paused"
          && Date.now() < entry.expiresAt
          && !entry.orchestration
          && !isTerminalWorkflowRun(entry.workflow)
        ) actions.unshift("* Resume");
        actions.push("< Back");

        const detail = entry.workflow
          ? formatWorkflowInspection(entry)
          : entry.orchestration
            ? formatOrchestrationInspection(entry)
            : `#${entry.id}: ${entry.prompt}\nTrigger: ${JSON.stringify(entry.trigger)}`;
        const action = await ui.select(detail, actions);

        if (entry.orchestration && (action === "x Delete" || action === "- Pause")) {
          const result = await cancelOrchestration?.(entry.id, action === "x Delete" ? "delete" : "pause") ?? "rejected";
          ui.notify(orchestrationCancellationMessage(entry.id, result), result === "rejected" ? "error" : result === "deleted" ? "info" : "warning");
          return viewLoops(ui);
        }
        if (action === "x Delete") {
          getTriggerSystem().remove(entry.id);
          getStore().delete(entry.id);
          updateWidget();
          ui.notify(`Loop #${entry.id} deleted`, "info");
        } else if (action === "- Pause") {
          getStore().pause(entry.id);
          getTriggerSystem().remove(entry.id);
          updateWidget();
          ui.notify(`Loop #${entry.id} paused`, "info");
        } else if (action === "* Resume") {
          const resumed = getStore().resume(entry.id);
          if (!resumed) return viewLoops(ui);
          getTriggerSystem().add(resumed);
          updateWidget();
          ui.notify(`Loop #${entry.id} resumed`, "info");
          if (resumed.trigger.type === "dynamic") onDynamicLoopActivated?.(resumed);
        }
      }
    }

    return viewLoops(ui);
  }

  async function settings(ui: ExtensionUIContext) {
    const loops = getStore().list();
    const active = loops.filter((l) => l.status === "active").length;
    ui.notify(`${active}/${loops.length} active loops (max 25)`, "info");
  }

  pi.registerCommand("loop", {
    description: "Create a loop. Prefix with --expires-in <duration> to override its lifetime; then use [interval] [prompt], event <source> <prompt>, or <goal> for a dynamic goal loop.",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const ui = ctx.ui;
      const expiry = extractExpiryOverride(args);
      if (expiry.error) {
        ui.notify(expiry.error, "error");
        return;
      }
      const route = parseLoopCommandRoute(expiry.args);

      if (route.type === "menu") {
        const choice = await ui.select("Loop", [
          "Create scheduled loop",
          "Create event-triggered loop",
          "View loops",
          "Settings",
        ]);

        if (!choice) return;
        if (choice.startsWith("Create scheduled")) return scheduleLoop(ui, undefined, expiry.expiresIn);
        if (choice.startsWith("Create event")) return eventLoop(ui, undefined, undefined, expiry.expiresIn);
        if (choice.startsWith("View loops")) return viewLoops(ui);
        return settings(ui);
      }

      if (route.type === "event") return eventLoop(ui, route.prompt, route.source, expiry.expiresIn);
      if (route.type === "cron") return createCronLoop(ui, route.interval, route.prompt, route.notifyEvery, expiry.expiresIn);
      if (route.type === "invalid-cron") {
        ui.notify(`Invalid cron expression: ${route.interval}`, "error");
        return;
      }
      if (route.type === "missing-interval-prompt") {
        ui.notify("Provide a prompt after the interval, e.g., /loop 5m check the deploy", "warning");
        return;
      }
      return dynamicLoop(ui, route.goal, expiry.expiresIn);
    },
  });
}
