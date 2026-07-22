import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { MonitorManager } from "../monitor-manager.js";
import type { LoopStore } from "../store.js";
import type { LoopEntry } from "../types.js";

interface TaskSummary {
  count: number;
  focusText?: string;
}

export class LoopWidget {
  private uiCtx: ExtensionUIContext | undefined;
  private taskSummaryProvider: (() => TaskSummary) | undefined;

  constructor(
    private store: LoopStore,
    private monitorManager: MonitorManager,
  ) {}

  setUICtx(ctx: ExtensionUIContext) {
    this.uiCtx = ctx;
  }

  setStore(store: LoopStore) {
    this.store = store;
  }

  setTaskSummaryProvider(provider: (() => TaskSummary) | undefined) {
    this.taskSummaryProvider = provider;
  }

  update() {
    if (!this.uiCtx) return;
    this.uiCtx.setStatus("loops", this.computeStatus());
  }

  private computeStatus(): string | undefined {
    const loops = this.store.list().filter(isStatusVisibleLoop);
    const monitors = this.monitorManager.list().filter((monitor) => monitor.status === "running");
    const taskSummary = this.taskSummaryProvider?.() ?? { count: 0 };

    if (loops.length === 0 && monitors.length === 0 && taskSummary.count === 0) {
      return undefined;
    }

    const parts: string[] = [];
    if (loops.length > 0) parts.push(`↻ ${formatCount(loops.length, "loop")}`);
    if (monitors.length > 0) parts.push(`▶ ${formatCount(monitors.length, "monitor")}`);
    if (taskSummary.count > 0) parts.push(`□ ${formatCount(taskSummary.count, "task")}`);

    let line = parts.join(" · ");
    if (taskSummary.focusText) line += ` | ${taskSummary.focusText}`;
    return line;
  }

  dispose() {
    this.uiCtx?.setStatus("loops", undefined);
  }
}

function formatCount(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function isStatusVisibleLoop(loop: LoopEntry): boolean {
  if (loop.status !== "active") return false;
  if (loop.recurring) return true;
  return !(loop.trigger.type === "event" && loop.trigger.source === "monitor:done");
}
