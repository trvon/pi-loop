import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { MonitorManager } from "../monitor-manager.js";
import type { LoopStore } from "../store.js";
import type { TaskEntry } from "../task-types.js";
import type { LoopEntry } from "../types.js";
import { orchestrationWidgetSummary } from "./orchestration-presentation.js";
import { type ProgressPanelMode, ProgressPanelOverlay } from "./progress-panel-overlay.js";
import { deriveWorkflowActivity, formatCompactWorkflowDuration } from "./workflow-presentation.js";

interface TaskSummary {
  count: number;
  focusText?: string;
}

export class LoopWidget {
  private uiCtx: ExtensionUIContext | undefined;
  private taskSummaryProvider: (() => TaskSummary) | undefined;
  private activityRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  // pi requests a full render on every setStatus, so identical text is skipped.
  // `null` means "nothing painted yet" and is distinct from a cleared status.
  private lastStatus: string | undefined | null = null;
  private taskListProvider: (() => readonly TaskEntry[]) | undefined;
  private readonly panel: ProgressPanelOverlay;

  constructor(
    private store: LoopStore,
    private monitorManager: MonitorManager,
    panelMode: ProgressPanelMode = "auto",
  ) {
    this.panel = new ProgressPanelOverlay(panelMode);
  }

  setUICtx(ctx: ExtensionUIContext) {
    // Hooks rebind the same UI every turn; only a different UI needs a repaint.
    if (ctx !== this.uiCtx) this.lastStatus = null;
    this.uiCtx = ctx;
    this.panel.setUI(ctx);
  }

  setStore(store: LoopStore) {
    this.clearActivityRefresh();
    this.store = store;
    this.lastStatus = null;
  }

  setTaskSummaryProvider(provider: (() => TaskSummary) | undefined) {
    this.taskSummaryProvider = provider;
  }

  /** Standalone tasks for the side panel; absent while an external provider owns tasks. */
  setTaskListProvider(provider: (() => readonly TaskEntry[]) | undefined) {
    this.taskListProvider = provider;
  }

  getPanelMode(): ProgressPanelMode {
    return this.panel.getMode();
  }

  setPanelMode(mode: ProgressPanelMode) {
    this.panel.setMode(mode);
    this.update();
  }

  update() {
    if (!this.uiCtx) return;
    this.clearActivityRefresh();
    const entries = this.store.list();
    const status = this.computeStatus(entries);
    if (status !== this.lastStatus) {
      this.uiCtx.setStatus("loops", status);
      this.lastStatus = status;
    }
    const tasks = this.taskListProvider?.() ?? [];
    this.panel.sync({ loops: entries, tasks, now: Date.now() });
    this.scheduleActivityRefresh(entries, tasks);
  }

  private computeStatus(entries: LoopEntry[]): string | undefined {
    const loops = entries.filter(isStatusVisibleLoop);
    const workflows = loops.filter((loop) => loop.workflow !== undefined);
    const orchestrations = loops.filter((loop) => loop.orchestration !== undefined);
    const ordinaryLoops = loops.filter((loop) => loop.workflow === undefined && loop.orchestration === undefined);
    const monitors = this.monitorManager.list().filter((monitor) => monitor.status === "running");
    const taskSummary = this.taskSummaryProvider?.() ?? { count: 0 };

    if (loops.length === 0 && monitors.length === 0 && taskSummary.count === 0) {
      return undefined;
    }

    const parts: string[] = [];
    if (ordinaryLoops.length > 0) parts.push(`↻ ${formatCount(ordinaryLoops.length, "loop")}`);
    if (workflows.length > 0) parts.push(`◆ ${formatCount(workflows.length, "workflow")}`);
    if (orchestrations.length > 0) parts.push(`◇ ${formatCount(orchestrations.length, "orchestration")}`);
    if (monitors.length > 0) parts.push(`▶ ${formatCount(monitors.length, "monitor")}`);
    if (taskSummary.count > 0) parts.push(`□ ${formatCount(taskSummary.count, "task")}`);

    let line = parts.join(" · ");
    const monitor = monitors[0];
    if (monitors.length === 1 && monitor) {
      const activity = formatMonitorActivity(monitor);
      if (activity) line += ` | ${activity}`;
    }
    const workflow = workflows.length === 1 ? workflows[0] : undefined;
    if (workflow?.workflow) {
      const activity = deriveWorkflowActivity(workflow);
      line += ` | #${workflow.id} ${activity.status} ${formatCompactWorkflowDuration(activity.activityMs)} · ${workflow.workflow.currentState} ${formatCompactWorkflowDuration(activity.stateAgeMs)} · age ${formatCompactWorkflowDuration(activity.workflowAgeMs)}`;
    }
    const orchestration = orchestrations.length === 1 ? orchestrations[0] : undefined;
    if (orchestration?.orchestration) {
      line += ` | ${orchestrationWidgetSummary(orchestration)}`;
    }
    if (taskSummary.focusText) line += ` | ${taskSummary.focusText}`;
    return line;
  }

  dispose() {
    this.clearActivityRefresh();
    this.uiCtx?.setStatus("loops", undefined);
    this.lastStatus = null;
    this.panel.dispose();
  }

  private scheduleActivityRefresh(entries: LoopEntry[], tasks: readonly TaskEntry[]) {
    // Both the workflow activity and a task's stale-claim flag flip at a lease
    // expiry, so repaint at the earliest live one of either kind.
    const now = Date.now();
    let expiresAt: number | undefined;
    const consider = (leaseExpiry: number | undefined) => {
      if (leaseExpiry !== undefined && leaseExpiry > now && (expiresAt === undefined || leaseExpiry < expiresAt)) expiresAt = leaseExpiry;
    };
    for (const entry of entries) {
      if (entry.workflow && isStatusVisibleLoop(entry)) consider(entry.workflow.activeExecution?.lease?.expiresAt);
    }
    for (const task of tasks) {
      if (task.status === "in_progress") consider(task.claim?.leaseExpiresAt);
    }
    if (expiresAt === undefined) return;
    this.activityRefreshTimer = setTimeout(() => {
      this.activityRefreshTimer = undefined;
      this.update();
    }, expiresAt - Date.now());
    this.activityRefreshTimer.unref?.();
  }

  private clearActivityRefresh() {
    if (this.activityRefreshTimer === undefined) return;
    clearTimeout(this.activityRefreshTimer);
    this.activityRefreshTimer = undefined;
  }
}

function formatMonitorProgress(monitor: { progress?: { current?: number; total?: number; message?: string } }): string {
  const { progress } = monitor;
  if (!progress) return "";
  if (progress.current !== undefined && progress.total !== undefined && progress.total > 0) {
    return `${Math.round((progress.current / progress.total) * 100)}%`;
  }
  return progress.message ?? "progress updated";
}

function formatMonitorActivity(monitor: {
  progress?: { current?: number; total?: number; message?: string; updatedAt?: number };
  startedAt: number;
  lastActivityAt?: number;
  lastOutputAt?: number;
  outputRatePerMinute?: number;
}): string | undefined {
  const progress = monitor.progress ? formatMonitorProgress(monitor) : undefined;
  const now = Date.now();
  const lastActivityAt = Math.max(
    monitor.startedAt,
    monitor.lastActivityAt ?? 0,
    monitor.lastOutputAt ?? 0,
    monitor.progress?.updatedAt ?? 0,
  );
  const silence = now - lastActivityAt;
  const activity = silence >= 60000
    ? `quiet ${Math.round(silence / 60000)}m`
    : monitor.lastOutputAt !== undefined && now - monitor.lastOutputAt < 60000 && monitor.outputRatePerMinute !== undefined
      ? `${monitor.outputRatePerMinute} lines/min`
      : undefined;
  return [progress, activity].filter(Boolean).join(" · ") || undefined;
}

function formatCount(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function isStatusVisibleLoop(loop: LoopEntry): boolean {
  if ((loop.workflow || loop.orchestration) && loop.status === "paused") return true;
  if (loop.status !== "active") return false;
  if (loop.recurring) return true;
  return !(loop.trigger.type === "event" && loop.trigger.source === "monitor:done");
}
