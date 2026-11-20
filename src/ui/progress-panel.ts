import { visibleWidth } from "@earendil-works/pi-tui";
import { getOrchestrationCounts } from "../orchestration-reducer.js";
import type { TaskEntry } from "../task-types.js";
import type { LoopEntry, MonitorEntry } from "../types.js";
import { getWorkflowOutcomeAvailability } from "../workflow-reducer.js";
import { activeCardGlyphs } from "./card-style.js";
import { isOrchestrationInProgress, orchestrationInFlightLabel, orchestrationStatusLabel } from "./orchestration-presentation.js";
import { deriveWorkflowActivity, formatCompactWorkflowDuration, workflowAttemptLabel } from "./workflow-presentation.js";

/**
 * Pure layout for the in-progress side panel. It returns toned segments and
 * never touches a theme, a terminal, or a store, so the same layout is
 * property-tested, benchmarked, and rendered.
 *
 * Authority: workflow and orchestration rows derive only from LoopStore
 * entries; task rows derive only from standalone TaskStore entries. Nothing
 * here claims, resumes, schedules, or infers unobserved execution.
 */

export type PanelTone = "accent" | "success" | "warning" | "error" | "muted" | "dim" | "text";

export interface PanelSegment {
  text: string;
  tone: PanelTone;
}

export type PanelLine = PanelSegment[];

export interface ProgressPanelInput {
  loops: readonly LoopEntry[];
  tasks: readonly TaskEntry[];
  /** Process-local monitor snapshots; absent means none are known to be running. */
  monitors?: readonly MonitorEntry[];
  now: number;
}

export const PANEL_MIN_WIDTH = 16;
const MAX_DETAILED_WORKFLOWS = 2;
const MAX_STATE_ROWS = 6;
const MAX_TASK_ROWS = 5;
const MAX_ORCHESTRATION_ROWS = 2;
const MAX_ORCHESTRATION_ITEM_ROWS = 5;
const MAX_MONITOR_ROWS = 3;
/** Silence longer than this is flagged; a long build with no output is worth a glance. */
const MONITOR_QUIET_MS = 5 * 60_000;

// Subjects, goals, and state names are model- or user-authored. Control and
// escape bytes must never reach the terminal from a persistent overlay.
export function plainPanelText(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim();
}

function seg(text: string, tone: PanelTone = "text"): PanelSegment {
  return { text, tone };
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Clips plain text to `width` columns. pi-tui's truncateToWidth appends ANSI
 * resets, which would leak styling into a layout that must stay theme-free.
 */
export function clipPanelText(text: string, width: number, ellipsis = "…"): string {
  if (width <= 0) return "";
  if (visibleWidth(text) <= width) return text;
  const budget = width - visibleWidth(ellipsis);
  let clipped = "";
  let used = 0;
  for (const { segment } of graphemes.segment(text)) {
    const segmentWidth = visibleWidth(segment);
    if (used + segmentWidth > budget) break;
    clipped += segment;
    used += segmentWidth;
  }
  return budget < 0 ? "" : clipped + ellipsis;
}

/** Truncates a line to `width` visible columns, keeping segment tones. */
export function fitPanelLine(line: PanelLine, width: number): PanelLine {
  const fitted: PanelLine = [];
  let remaining = Math.max(0, width);
  for (const segment of line) {
    if (remaining <= 0) break;
    const segmentWidth = visibleWidth(segment.text);
    if (segmentWidth <= remaining) {
      fitted.push(segment);
      remaining -= segmentWidth;
      continue;
    }
    const text = clipPanelText(segment.text, remaining);
    if (text) fitted.push({ text, tone: segment.tone });
    break;
  }
  return fitted;
}

export function panelLineText(line: PanelLine): string {
  return line.map((segment) => segment.text).join("");
}

function isPanelWorkflow(entry: LoopEntry): boolean {
  return entry.workflow !== undefined && (entry.status === "active" || entry.status === "paused");
}

function isPanelOrchestration(entry: LoopEntry): boolean {
  return isOrchestrationInProgress(entry);
}

export const ACTIVITY_TONE = {
  claimed: "accent",
  waiting: "muted",
  paused: "warning",
  idle: "warning",
  stopped: "dim",
} as const satisfies Record<string, PanelTone>;

/** A window of at most `size` state names that always contains the current state. */
export function stateWindow(names: string[], current: string, size = MAX_STATE_ROWS): { names: string[]; before: number; after: number } {
  if (names.length <= size) return { names, before: 0, after: 0 };
  const index = Math.max(0, names.indexOf(current));
  const start = Math.min(Math.max(0, index - 2), names.length - size);
  const end = start + size;
  return { names: names.slice(start, end), before: start, after: names.length - end };
}

/**
 * State names for a trail. A corrupt or mid-revision snapshot can name a
 * current state the definition lacks; it is listed first so the active work
 * never disappears from the trail.
 */
export function trailStateNames(workflow: NonNullable<LoopEntry["workflow"]>): string[] {
  const names = Object.keys(workflow.definition.states);
  return names.includes(workflow.currentState) ? names : [workflow.currentState, ...names];
}

function workflowLines(entry: LoopEntry, now: number): PanelLine[] {
  const workflow = entry.workflow;
  if (!workflow) return [];
  const activity = deriveWorkflowActivity(entry, now);
  const lines: PanelLine[] = [[seg("◆ ", "accent"), seg(`#${entry.id} `, "dim"), seg(plainPanelText(entry.prompt))]];
  const window = stateWindow(trailStateNames(workflow), workflow.currentState);
  if (window.before > 0) lines.push([seg(`  ⋮ ${window.before} earlier`, "dim")]);
  for (const name of window.names) {
    const label = plainPanelText(name);
    if (name === workflow.currentState) {
      const attempt = ` · try ${workflowAttemptLabel(entry)}`;
      lines.push([seg("  ▶ ", ACTIVITY_TONE[activity.status]), seg(label, "accent"), seg(attempt, "dim")]);
      const waiting = workflow.waitingMonitor ? ` monitor #${plainPanelText(workflow.waitingMonitor.monitorId)}` : "";
      lines.push([seg(
        `    ${activity.status}${waiting} ${formatCompactWorkflowDuration(activity.activityMs)}`,
        ACTIVITY_TONE[activity.status],
      )]);
    } else if ((workflow.attemptsByState[name] ?? 0) > 0) {
      lines.push([seg("  ✓ ", "success"), seg(label, "dim")]);
    } else {
      lines.push([seg("  ○ ", "dim"), seg(label, "muted")]);
    }
  }
  if (window.after > 0) lines.push([seg(`  ⋮ ${window.after} later`, "dim")]);
  const outcomes = getWorkflowOutcomeAvailability(workflow).available;
  if (outcomes.length > 0) lines.push([seg("  → ", "dim"), seg(outcomes.map(plainPanelText).join(", "), "muted")]);
  return lines;
}

function orchestrationLine(entry: LoopEntry): PanelLine {
  const state = entry.orchestration;
  if (!state) return [];
  const counts = getOrchestrationCounts(state);
  // Only in-progress batches reach the panel, so the row is either dispatching or waiting on the user.
  const tone: PanelTone = state.status === "needs_attention" ? "warning" : "accent";
  const detail = state.status === "active"
    ? `· ${orchestrationInFlightLabel(state)}`
    : orchestrationStatusLabel(state.status);
  return [
    seg("◇ ", tone),
    seg(`#${entry.id} `, "dim"),
    seg(`${counts.completed}/${state.work.length} `),
    seg(detail, tone === "accent" ? "muted" : tone),
  ];
}

/**
 * Running monitors only. Output is untrusted process text, so it passes through
 * the same control-byte stripping as model-authored names. Nothing here stops,
 * waits on, or infers the state of a process beyond its last reported snapshot.
 */
function monitorLines(monitors: readonly MonitorEntry[], now: number): PanelLine[] {
  const running = monitors.filter((monitor) => monitor.status === "running").sort((a, b) => a.startedAt - b.startedAt);
  const lines: PanelLine[] = [];
  for (const monitor of running.slice(0, MAX_MONITOR_ROWS)) {
    const label = plainPanelText(monitor.description?.trim() ? monitor.description : monitor.command ?? "");
    lines.push([
      seg("▶ ", "accent"),
      seg(`#${plainPanelText(monitor.id)} `, "dim"),
      seg(`${formatCompactWorkflowDuration(now - monitor.startedAt)} `, "muted"),
      seg(label),
    ]);
    // A monitor that never printed has been silent since it started.
    const quietMs = now - (monitor.lastOutputAt ?? monitor.startedAt);
    const lastLine = plainPanelText(monitor.outputBuffer?.at(-1) ?? "");
    if (quietMs >= MONITOR_QUIET_MS) {
      lines.push([seg(`    quiet ${formatCompactWorkflowDuration(quietMs)} `, "warning"), seg(lastLine, "dim")]);
    } else if (lastLine) {
      lines.push([seg("    ", "dim"), seg(lastLine, "dim")]);
    }
  }
  if (running.length > MAX_MONITOR_ROWS) lines.push([seg(`▶ … ${running.length - MAX_MONITOR_ROWS} more`, "dim")]);
  return lines;
}

function taskLines(tasks: readonly TaskEntry[], now: number): PanelLine[] {
  const counted = tasks.filter((task) => task.status !== "closed");
  const open = counted.filter((task) => task.status === "in_progress" || task.status === "pending");
  if (open.length === 0) return [];
  const done = counted.length - open.length;
  const lines: PanelLine[] = [[seg("□ ", "accent"), seg("Tasks "), seg(`${done}/${counted.length} done`, "muted")]];
  // In-progress first: it is what the operator is watching for.
  const ordered = [
    ...open.filter((task) => task.status === "in_progress"),
    ...open.filter((task) => task.status === "pending"),
  ];
  for (const task of ordered.slice(0, MAX_TASK_ROWS)) {
    if (task.status === "in_progress") {
      const stale = task.claim !== undefined && task.claim.leaseExpiresAt <= now;
      const since = task.claim?.claimedAt ?? task.updatedAt;
      const age = formatCompactWorkflowDuration(now - since);
      lines.push([
        seg("  ◼ ", stale ? "warning" : "accent"),
        seg(`#${task.id} `, "dim"),
        seg(stale ? `stale claim ${age} ` : `${age} `, stale ? "warning" : "dim"),
        seg(plainPanelText(task.subject)),
      ]);
    } else {
      lines.push([seg("  ◻ ", "dim"), seg(`#${task.id} `, "dim"), seg(plainPanelText(task.subject), "muted")]);
    }
  }
  if (ordered.length > MAX_TASK_ROWS) lines.push([seg(`  … ${ordered.length - MAX_TASK_ROWS} more`, "dim")]);
  return lines;
}

/** Compact token count: the panel has room for magnitude, not digits. */
function compactTokens(total: number): string {
  if (total < 1_000) return String(total);
  if (total < 999_500) return `${Math.round(total / 1_000)}k`;
  return `${(total / 1_000_000).toFixed(1)}M`;
}

type WorkItem = NonNullable<LoopEntry["orchestration"]>["work"][number];

// What still needs watching comes first; finished work is the first to scroll out of the bounded rows.
const ITEM_ORDER: Record<WorkItem["status"], number> = { active: 0, failed: 1, uncertain: 1, pending: 2, completed: 3, cancelled: 4 };
const REPORTED_STATE: Partial<Record<WorkItem["dispatches"][number]["status"], string>> = { spawning: "starting", queued: "queued", running: "running", verifying: "verifying" };

function orchestrationItemLine(item: WorkItem, now: number): PanelLine {
  const name = seg(plainPanelText(item.label ?? item.prompt), item.status === "active" ? "text" : "muted");
  const dispatch = item.dispatches.at(-1);
  if (item.status === "active") {
    // Last reported state and time since it was asked for: evidence of dispatch, not of a live worker.
    const reported = dispatch ? REPORTED_STATE[dispatch.status] : undefined;
    const detail = dispatch && reported
      ? `${reported} ${formatCompactWorkflowDuration(now - (dispatch.startedAt ?? dispatch.requestedAt))}${dispatch.attempt > 1 ? ` · try ${dispatch.attempt}` : ""} `
      : "";
    return [seg("  ● ", "accent"), seg(detail, "dim"), name];
  }
  if (item.status === "completed") {
    const duration = dispatch?.usage?.durationMs;
    const tokens = dispatch?.usage?.tokens?.total;
    const detail = [
      ...(duration !== undefined ? [formatCompactWorkflowDuration(duration)] : []),
      ...(tokens !== undefined ? [`${compactTokens(tokens)} tok`] : []),
    ].join(" · ");
    return [seg("  ✓ ", "success"), seg(detail ? `${detail} ` : "", "dim"), name];
  }
  if (item.status === "failed") return [seg("  ✗ ", "warning"), seg("failed ", "warning"), name];
  if (item.status === "uncertain") return [seg("  ? ", "warning"), seg("uncertain ", "warning"), name];
  if (item.status === "cancelled") return [seg("  – ", "dim"), name];
  return [seg("  ○ ", "dim"), name];
}

function orchestrationLines(entry: LoopEntry, now: number): PanelLine[] {
  const work = entry.orchestration?.work ?? [];
  // Array.prototype.sort is stable, so items keep batch order within a rank.
  const ordered = [...work].sort((a, b) => ITEM_ORDER[a.status] - ITEM_ORDER[b.status]);
  const lines = [orchestrationLine(entry), ...ordered.slice(0, MAX_ORCHESTRATION_ITEM_ROWS).map((item) => orchestrationItemLine(item, now))];
  if (ordered.length > MAX_ORCHESTRATION_ITEM_ROWS) lines.push([seg(`    … ${ordered.length - MAX_ORCHESTRATION_ITEM_ROWS} more`, "dim")]);
  return lines;
}

/**
 * Lays out the panel body. Every returned line fits `width` visible columns and
 * at most `maxRows` lines are returned; an empty result means "hide the panel".
 */
export function layoutProgressPanel(input: ProgressPanelInput, width: number, maxRows: number): PanelLine[] {
  if (width < PANEL_MIN_WIDTH || maxRows < 1) return [];
  const { now } = input;
  const lines: PanelLine[] = [];

  // Attention first: a paused or unclaimed workflow outranks a healthy claimed one.
  const workflows = input.loops.filter(isPanelWorkflow).sort((a, b) => {
    const rank = (entry: LoopEntry) => {
      const status = deriveWorkflowActivity(entry, now).status;
      return status === "paused" ? 0 : status === "idle" ? 1 : 2;
    };
    return rank(a) - rank(b) || Number(a.id) - Number(b.id);
  });
  for (const entry of workflows.slice(0, MAX_DETAILED_WORKFLOWS)) lines.push(...workflowLines(entry, now));
  if (workflows.length > MAX_DETAILED_WORKFLOWS) {
    lines.push([seg(`◆ … ${workflows.length - MAX_DETAILED_WORKFLOWS} more workflows`, "dim")]);
  }

  const orchestrations = input.loops.filter(isPanelOrchestration);
  for (const entry of orchestrations.slice(0, MAX_ORCHESTRATION_ROWS)) lines.push(...orchestrationLines(entry, now));
  if (orchestrations.length > MAX_ORCHESTRATION_ROWS) {
    lines.push([seg(`◇ … ${orchestrations.length - MAX_ORCHESTRATION_ROWS} more`, "dim")]);
  }

  lines.push(...monitorLines(input.monitors ?? [], now));
  lines.push(...taskLines(input.tasks, now));

  const bounded = lines.length > maxRows
    ? [...lines.slice(0, maxRows - 1), [seg(`… ${lines.length - maxRows + 1} more rows`, "dim")]]
    : lines;
  return bounded.map((line) => fitPanelLine(line, width));
}

const CARD_TASKS = 3;
const CARD_SUBJECT_WIDTH = 20;

/** One dense line of open standalone tasks for the collapsed TaskList card. */
export function taskCardPreview(tasks: readonly TaskEntry[], now: number): PanelLine[] {
  const open = [
    ...tasks.filter((task) => task.status === "in_progress"),
    ...tasks.filter((task) => task.status === "pending"),
  ];
  if (open.length === 0) return [];
  const glyphs = activeCardGlyphs();
  const line: PanelLine = [seg("  ", "dim")];
  open.slice(0, CARD_TASKS).forEach((task, index) => {
    if (index > 0) line.push(seg(glyphs.field, "dim"));
    const active = task.status === "in_progress";
    const stale = active && task.claim !== undefined && task.claim.leaseExpiresAt <= now;
    line.push(
      seg(active ? glyphs.taskActive : glyphs.taskPending, stale ? "warning" : active ? "accent" : "dim"),
      seg(`#${task.id} `, "dim"),
      seg(stale ? "STALE " : "", "warning"),
      seg(clipPanelText(plainPanelText(task.subject), CARD_SUBJECT_WIDTH, glyphs.ellipsis), active ? "text" : "muted"),
    );
  });
  if (open.length > CARD_TASKS) line.push(seg(`${glyphs.field}+${open.length - CARD_TASKS}`, "dim"));
  return [line];
}
