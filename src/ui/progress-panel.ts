import { visibleWidth } from "@earendil-works/pi-tui";
import { getOrchestrationCounts } from "../orchestration-reducer.js";
import type { TaskEntry } from "../task-types.js";
import type { LoopEntry } from "../types.js";
import { getWorkflowOutcomeAvailability } from "../workflow-reducer.js";
import { activeCardGlyphs } from "./card-style.js";
import { orchestrationStatusLabel } from "./orchestration-presentation.js";
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
  now: number;
}

export const PANEL_MIN_WIDTH = 16;
const MAX_DETAILED_WORKFLOWS = 2;
const MAX_STATE_ROWS = 6;
const MAX_TASK_ROWS = 5;
const MAX_ORCHESTRATION_ROWS = 2;

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
  return entry.orchestration !== undefined && (entry.status === "active" || entry.status === "paused");
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

function workflowLines(entry: LoopEntry, now: number): PanelLine[] {
  const workflow = entry.workflow;
  if (!workflow) return [];
  const activity = deriveWorkflowActivity(entry, now);
  const lines: PanelLine[] = [[seg("◆ ", "accent"), seg(`#${entry.id} `, "dim"), seg(plainPanelText(entry.prompt))]];
  const window = stateWindow(Object.keys(workflow.definition.states), workflow.currentState);
  if (window.before > 0) lines.push([seg(`  ⋮ ${window.before} earlier`, "dim")]);
  for (const name of window.names) {
    const label = plainPanelText(name);
    if (name === workflow.currentState) {
      const state = workflow.definition.states[name];
      const attempt = state?.maxAttempts !== undefined || (workflow.attemptsByState[name] ?? 1) > 1
        ? ` · try ${workflowAttemptLabel(entry)}`
        : "";
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
  const tone: PanelTone = state.status === "needs_attention" ? "warning" : state.status === "completed" ? "success" : "accent";
  const detail = state.status === "active"
    ? `${counts.active} reserved`
    : orchestrationStatusLabel(state.status);
  return [
    seg("◇ ", tone),
    seg(`#${entry.id} `, "dim"),
    seg(`${counts.completed}/${state.work.length} `),
    seg(detail, tone === "accent" ? "muted" : tone),
  ];
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
  for (const entry of orchestrations.slice(0, MAX_ORCHESTRATION_ROWS)) lines.push(orchestrationLine(entry));
  if (orchestrations.length > MAX_ORCHESTRATION_ROWS) {
    lines.push([seg(`◇ … ${orchestrations.length - MAX_ORCHESTRATION_ROWS} more`, "dim")]);
  }

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
