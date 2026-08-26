import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { MonitorManager } from "../monitor-manager.js";
import { getOrchestrationCounts } from "../orchestration-reducer.js";
import type { LoopStore } from "../store.js";
import type { LoopEntry } from "../types.js";
import { workflowAttemptLabel, workflowLeaseLabel } from "./workflow-presentation.js";

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
      line += ` | #${workflow.id} ${workflow.workflow.currentState} · attempt ${workflowAttemptLabel(workflow)} · ${workflowLeaseLabel(workflow)}`;
    }
    const orchestration = orchestrations.length === 1 ? orchestrations[0] : undefined;
    if (orchestration?.orchestration) {
      const counts = getOrchestrationCounts(orchestration.orchestration);
      line += ` | #${orchestration.id} ${orchestration.orchestration.status} · ${counts.completed}/${orchestration.orchestration.work.length} done · ${counts.active} active`;
    }
    if (taskSummary.focusText) line += ` | ${taskSummary.focusText}`;
    return line;
  }

  dispose() {
    this.uiCtx?.setStatus("loops", undefined);
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
  if (loop.status !== "active") return false;
  if (loop.recurring) return true;
  return !(loop.trigger.type === "event" && loop.trigger.source === "monitor:done");
}
