import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { parseInterval } from "../loop-parse.js";
import type { LoopEntry, Trigger } from "../types.js";

interface LoopStoreLike {
  list(): LoopEntry[];
  get(id: string): LoopEntry | undefined;
  create(trigger: Trigger, prompt: string, options?: Partial<LoopEntry>): LoopEntry;
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
}

export function registerLoopCommand(options: LoopCommandOptions): void {
  const { pi, getStore, getTriggerSystem, updateWidget } = options;

  async function scheduleLoop(ui: ExtensionUIContext, prompt?: string) {
    const p = prompt || await ui.input("Prompt (what should the agent check?)");
    if (!p) return;

    const interval = await ui.input("Interval (e.g., 5m, 2h, 1d)");
    if (!interval) return;

    try {
      const parsed = parseInterval(interval);
      const trigger: Trigger = { type: "cron", schedule: parsed.cron };
      const entry = getStore().create(trigger, p, { recurring: true });
      getTriggerSystem().add(entry);
      updateWidget();
      ui.notify(`Loop #${entry.id} created: every ${parsed.description}`, "info");
    } catch (err: unknown) {
      ui.notify((err as Error).message, "error");
    }
  }

  async function eventLoop(ui: ExtensionUIContext, prompt?: string) {
    const p = prompt || await ui.input("Prompt");
    if (!p) return;

    const source = await ui.input("Pi event source (e.g., tool_execution_start, before_agent_start)");
    if (!source) return;

    const trigger: Trigger = { type: "event", source };
    const entry = getStore().create(trigger, p, { recurring: true });
    getTriggerSystem().add(entry);
    updateWidget();
    ui.notify(`Event loop #${entry.id} created: fires on "${source}"`, "info");
  }

  async function viewLoops(ui: ExtensionUIContext) {
    const loops = getStore().list();
    if (loops.length === 0) {
      await ui.select("No active loops", ["< Back"]);
      return;
    }

    const choices = loops.map((l) => {
      const icon = l.status === "active" ? "*" : l.status === "paused" ? "-" : "x";
      const triggerDesc = l.trigger.type === "cron"
        ? `cron: ${l.trigger.schedule}`
        : l.trigger.type === "event"
          ? `event: ${l.trigger.source}`
          : `hybrid: ${l.trigger.cron}`;
      return `${icon} #${l.id} [${l.status}] ${l.prompt.slice(0, 50)} (${triggerDesc})`;
    });
    choices.push("< Back");

    const selected = await ui.select("Active Loops", choices);
    if (!selected || selected === "< Back") return;

    const match = selected.match(/#(\d+)/);
    if (match) {
      const entry = getStore().get(match[1]);
      if (entry) {
        const actions = ["x Delete"];
        if (entry.status === "active") actions.unshift("- Pause");
        else if (entry.status === "paused") actions.unshift("* Resume");
        actions.push("< Back");

        const action = await ui.select(
          `#${entry.id}: ${entry.prompt}\nTrigger: ${JSON.stringify(entry.trigger)}`,
          actions,
        );

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
          getStore().resume(entry.id);
          getTriggerSystem().add(entry);
          updateWidget();
          ui.notify(`Loop #${entry.id} resumed`, "info");
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
    description: "Create a repeating scheduled task: /loop [interval] [prompt]. E.g., /loop 5m check the deploy, /loop 30s am I still here",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const trimmed = args.trim();
      const ui = ctx.ui;

      if (!trimmed) {
        const choice = await ui.select("Loop", [
          "Create scheduled loop",
          "Create event-triggered loop",
          "View active loops",
          "Settings",
        ]);

        if (!choice) return;
        if (choice.startsWith("Create scheduled")) return scheduleLoop(ui);
        if (choice.startsWith("Create event")) return eventLoop(ui);
        if (choice.startsWith("View active")) return viewLoops(ui);
        return settings(ui);
      }

      const intervalMatch = trimmed.match(/^(\d+\s*[smhdS]\b)/i);
      if (intervalMatch) {
        const interval = intervalMatch[1];
        const prompt = trimmed.slice(intervalMatch[0].length).trim();

        if (!prompt) {
          ui.notify("Provide a prompt after the interval, e.g., /loop 5m check the deploy", "warning");
          return;
        }

        try {
          const parsed = parseInterval(interval);
          const trigger: Trigger = { type: "cron", schedule: parsed.cron };
          const entry = getStore().create(trigger, prompt, { recurring: true });
          getTriggerSystem().add(entry);
          updateWidget();
          ui.notify(`Loop #${entry.id} created: every ${parsed.description} — ${prompt.slice(0, 50)}`, "info");
        } catch (err: unknown) {
          ui.notify((err as Error).message, "error");
        }
        return;
      }

      const choice = await ui.select("Loop mode", [
        `Scheduled: "${trimmed.slice(0, 50)}"`,
        `Event-triggered: "${trimmed.slice(0, 50)}"`,
        `Self-paced: "${trimmed.slice(0, 50)}"`,
      ]);

      if (!choice) return;
      if (choice.startsWith("Event")) return eventLoop(ui, trimmed);
      return scheduleLoop(ui, trimmed);
    },
  });
}
