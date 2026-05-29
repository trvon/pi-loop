import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { MonitorManager } from "../monitor-manager.js";
import type { CronScheduler } from "../scheduler.js";
import type { LoopStore } from "../store.js";

const MAX_VISIBLE = 6;

export class LoopWidget {
  private uiCtx: ExtensionUIContext | undefined;
  private tui: TUI | undefined;
  private widgetRegistered = false;
  private interval: ReturnType<typeof setInterval> | undefined;

  constructor(
    private store: LoopStore,
    private scheduler: CronScheduler | undefined,
    private monitorManager: MonitorManager,
  ) {}

  setUICtx(ctx: ExtensionUIContext) {
    this.uiCtx = ctx;
  }

  setStore(store: LoopStore) {
    this.store = store;
  }

  setScheduler(scheduler: CronScheduler) {
    this.scheduler = scheduler;
  }

  update() {
    if (!this.uiCtx) return;

    const loops = this.store.list().filter(l => l.status === "active");
    const monitors = this.monitorManager.list();
    const hasContent = loops.length > 0 || monitors.length > 0;

    if (!hasContent) {
      if (this.widgetRegistered) {
        this.uiCtx.setWidget("loops", undefined);
        this.widgetRegistered = false;
      }
      if (this.interval) {
        clearInterval(this.interval);
        this.interval = undefined;
      }
      return;
    }

    if (!this.interval) {
      this.interval = setInterval(() => this.update(), 5000);
    }

    if (!this.widgetRegistered) {
      this.uiCtx.setWidget("loops", (tui: TUI, theme: Theme) => {
        this.tui = tui;
        return { render: () => this.renderWidget(tui, theme), invalidate: () => {} } as Component & { dispose?(): void };
      }, { placement: "aboveEditor" });
      this.widgetRegistered = true;
    } else if (this.tui) {
      (this.tui as any).requestRender();
    }
  }

  private renderWidget(tui: TUI, _theme: Theme): string[] {
    const loops = this.store.list().filter(l => l.status === "active");
    const runningMonitors = this.monitorManager.list().filter(m => m.status === "running");
    const completedMonitors = this.monitorManager.list().filter(m => m.status === "completed");
    const allMonitors = [...runningMonitors, ...completedMonitors];
    const w = tui.terminal.columns;
    const trunc = (line: string) => truncateToWidth(line, w);

    const lines: string[] = [];
    const total = loops.length + allMonitors.length;

    if (total === 0) return [];

    const headerParts: string[] = [`⟳ ${loops.length} loops`];
    if (runningMonitors.length > 0) headerParts.push(`${runningMonitors.length} running`);
    if (completedMonitors.length > 0) headerParts.push(`${completedMonitors.length} done`);
    lines.push(trunc(headerParts.join(" · ")));

    for (const loop of loops.slice(0, MAX_VISIBLE)) {
      const icon = "◷";
      let schedule = "";
      if (loop.trigger.type === "cron") {
        schedule = loop.trigger.schedule;
      } else if (loop.trigger.type === "event") {
        schedule = `event: ${loop.trigger.source}`;
      } else if (loop.trigger.type === "hybrid") {
        schedule = `hybrid: ${loop.trigger.cron}`;
      }
      const nextFire = this.scheduler?.nextFire(loop.id);
      let timing = "";
      if (nextFire) {
        const remaining = Math.max(0, nextFire - Date.now());
        timing = ` (next: ${formatDuration(remaining)})`;
      }
      lines.push(trunc(`  ${icon} #${loop.id} ${loop.prompt.slice(0, 50)} → ${schedule}${timing}`));
    }

    for (const m of allMonitors.slice(0, Math.max(0, MAX_VISIBLE - loops.length))) {
      const icon = m.status === "running" ? "◉" : "✓";
      const age = Date.now() - m.startedAt;
      const label = m.description || m.command.replace(/\n/g, " ").replace(/\s+/g, " ").trim().slice(0, 50);
      let line = `  ${icon} #${m.id} ${label} ${m.outputLines} lines (${formatDuration(age)})`;
      if (m.exitCode !== undefined && m.status !== "running") line += ` exit=${m.exitCode}`;
      lines.push(trunc(line));
    }

    return lines;
  }

  dispose() {
    if (this.interval) { clearInterval(this.interval); this.interval = undefined; }
    if (this.uiCtx) this.uiCtx.setWidget("loops", undefined);
    this.widgetRegistered = false;
    this.tui = undefined;
  }
}

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`;
}
