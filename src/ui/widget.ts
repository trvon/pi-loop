import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { MonitorManager } from "../monitor-manager.js";
import type { LoopStore } from "../store.js";

interface TaskSummary {
  count: number;
  focusText?: string;
}

export class LoopWidget {
  private uiCtx: ExtensionUIContext | undefined;
  private interval: ReturnType<typeof setInterval> | undefined;
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

    const status = this.computeStatus();
    if (status && !this.interval) {
      this.interval = setInterval(() => this.update(), 5000);
    }
    if (!status && this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }

    this.uiCtx.setStatus("loops", status);
  }

  private computeStatus(): string | undefined {
    const loops = this.store.list().filter(l => l.status === "active");
    const monitors = this.monitorManager.list();
    const taskSummary = this.taskSummaryProvider?.() ?? { count: 0 };

    if (loops.length === 0 && monitors.length === 0 && taskSummary.count === 0) {
      return undefined;
    }

    const parts: string[] = [];
    if (loops.length > 0) parts.push(formatCount(loops.length, "loop"));
    if (monitors.length > 0) parts.push(formatCount(monitors.length, "monitor"));
    if (taskSummary.count > 0) parts.push(formatCount(taskSummary.count, "task"));

    let line = parts.join(" · ");
    if (taskSummary.focusText) line += ` | ${taskSummary.focusText}`;
    return line;
  }

  dispose() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
    this.uiCtx?.setStatus("loops", undefined);
  }
}

function formatCount(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
