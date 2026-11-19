import { getOrchestrationCapacity, getOrchestrationCounts } from "../orchestration-reducer.js";
import type { OrchestrationCancellation } from "../runtime/subagent-orchestration-runtime.js";
import { displayRows, type ToolDisplayDetails, type ToolDisplayTone } from "../tools/tool-result.js";
import type {
  LoopEntry,
  OrchestrationConsumeStatus,
  OrchestrationDispatchStatus,
  OrchestrationState,
  OrchestrationStatus,
  OrchestrationWorkItem,
  OrchestrationWorkStatus,
} from "../types.js";

export function orchestrationCancellationMessage(id: string, result: OrchestrationCancellation): string {
  if (result === "deleted") return `Orchestration #${id} cancelled and deleted`;
  if (result === "paused") return `Orchestration #${id} cancelled and paused`;
  if (result === "retained") return `Orchestration #${id} cancellation recorded; retained and paused because worker termination is unconfirmed. No automatic retry or consume. Inspect OrchestrationGet; a stop request is not proof the worker ended.`;
  if (result === "context_changed") return `Orchestration #${id} session changed during cancellation; inspect the original session before retrying. Deletion is not confirmed.`;
  return `Orchestration #${id} cancellation failed; inspect OrchestrationGet and retry.`;
}

export function orchestrationStatusLabel(status: OrchestrationStatus): string {
  if (status === "active") return "active";
  if (status === "needs_attention") return "needs attention";
  if (status === "completed") return "complete";
  return "cancelled";
}

export function orchestrationWorkStatusLabel(status: OrchestrationWorkStatus): string {
  if (status === "pending") return "pending";
  if (status === "active") return "reserved";
  if (status === "completed") return "complete";
  return status;
}

function orchestrationDispatchStatusLabel(status: OrchestrationDispatchStatus): string {
  if (status === "spawning") return "starting";
  if (status === "running") return "reported running";
  if (status === "verifying") return "verifying";
  if (status === "completed") return "complete";
  return status;
}

function outputOwnershipLabel(status: OrchestrationConsumeStatus): string {
  if (status === "provider_owned") return "provider-owned";
  if (status === "consumed") return "transferred to pi-loop";
  if (status === "pending") return "transfer pending";
  if (status === "unavailable") return "unavailable";
  return "not applicable";
}

/**
 * Reserved work against what may be dispatched right now: the aimd window, or
 * the fixed concurrency. Capacity is shown only while the controller is still
 * dispatching; a reservation is local intent, not observed execution.
 */
export function orchestrationInFlightLabel(state: OrchestrationState): string {
  const reserved = getOrchestrationCounts(state).active;
  return state.status === "active" ? `${reserved}/${getOrchestrationCapacity(state)} in flight` : `${reserved} reserved`;
}

export function orchestrationProgressLabel(state: OrchestrationState): string {
  const counts = getOrchestrationCounts(state);
  const parts = [
    `${counts.completed}/${state.work.length} complete`,
    orchestrationInFlightLabel(state),
  ];
  for (const status of ["spawning", "queued", "running", "verifying"] as const) {
    const count = state.work.filter((item) => item.status === "active" && item.dispatches.at(-1)?.status === status).length;
    if (count > 0) parts.push(`${count} ${orchestrationDispatchStatusLabel(status)}`);
  }
  if (counts.pending > 0) parts.push(`${counts.pending} pending`);
  if (counts.failed > 0) parts.push(`${counts.failed} failed`);
  if (counts.uncertain > 0) parts.push(`${counts.uncertain} uncertain`);
  if (counts.cancelled > 0) parts.push(`${counts.cancelled} cancelled`);
  return parts.join(" · ");
}

export function orchestrationTone(
  state: OrchestrationState,
  item?: OrchestrationWorkItem,
): ToolDisplayTone {
  if (item?.status === "failed" || item?.status === "uncertain") return "warning";
  if (item?.status === "completed") return "success";
  if (item?.status === "cancelled") return "warning";
  if (state.status === "completed") return "success";
  if (state.status === "needs_attention" || state.status === "cancelled") return "warning";
  return "info";
}

function compactPrompt(prompt: string): string {
  return prompt.replace(/\s+/g, " ").slice(0, 120);
}

export function orchestrationWorkSummary(item: OrchestrationWorkItem): string {
  const dispatch = item.dispatches.at(-1);
  const label = item.agentType ?? "general-purpose";
  let line = `#${item.id} [${orchestrationWorkStatusLabel(item.status)}] ${label} · ${compactPrompt(item.prompt)}`;
  if (dispatch?.agentId) line += ` · agent=${dispatch.agentId}`;
  if (item.attemptCount > 0) line += ` · attempts=${item.attemptCount}`;
  return line;
}

/** Pacing limits: the aimd window against its ceiling, or the fixed concurrency. */
export function orchestrationLimitsLabel(state: OrchestrationState): string {
  if (!state.window) return `fixed concurrency=${state.concurrency} maxAttempts=${state.maxAttempts}`;
  // Before any loss the threshold is the ceiling and says nothing; it is shown once it sits below.
  const ssthresh = state.window.ssthresh < state.concurrency ? ` ssthresh=${state.window.ssthresh}` : "";
  return `aimd window=${Math.floor(state.window.cwnd)}/${state.concurrency}${ssthresh} losses=${state.window.losses} taskLosses=${state.window.taskLosses} maxAttempts=${state.maxAttempts}`;
}

export function orchestrationControllerText(entry: LoopEntry): string {
  const state = entry.orchestration;
  if (!state) return `Orchestration #${entry.id} unavailable`;
  return [
    `Orchestration #${entry.id} · ${orchestrationStatusLabel(state.status)}`,
    `Goal: ${state.goal}`,
    `Progress: ${orchestrationProgressLabel(state)}`,
    `Limits: ${orchestrationLimitsLabel(state)}`,
    "In flight: local reservations against capacity; dispatch state is last reported, not proof of current execution.",
    ...state.work.map(orchestrationWorkSummary),
  ].join("\n");
}

export function orchestrationWorkText(entry: LoopEntry, item: OrchestrationWorkItem): string {
  const state = entry.orchestration;
  if (!state) return `Orchestration #${entry.id} unavailable`;
  const lines = [
    `Orchestration #${entry.id} · Work #${item.id} · ${orchestrationWorkStatusLabel(item.status)}`,
    `Agent type: ${item.agentType ?? "general-purpose"}`,
    `Prompt: ${item.prompt}`,
    `Attempts: ${item.attemptCount - (item.congestionRetries ?? 0)}/${state.maxAttempts}${item.congestionRetries ? ` (+${item.congestionRetries} congestion re-send${item.congestionRetries === 1 ? "" : "s"})` : ""}`,
  ];
  for (const dispatch of item.dispatches) {
    lines.push(`Dispatch ${dispatch.attempt}: ${orchestrationDispatchStatusLabel(dispatch.status)}${dispatch.agentId ? ` · agent=${dispatch.agentId}` : ""}`);
    if (dispatch.result) lines.push(`Result: ${dispatch.result}`);
    if (dispatch.error) lines.push(`Error: ${dispatch.error}`);
    if (dispatch.status === "uncertain") lines.push("Termination: unconfirmed; automatic retry/consume disabled. Controller retained for inspection.");
    lines.push(`Output: ${outputOwnershipLabel(dispatch.consumeStatus)}`);
  }
  return lines.join("\n");
}

export function orchestrationDisplayDetails(
  entry: LoopEntry,
  item?: OrchestrationWorkItem,
): ToolDisplayDetails {
  const state = entry.orchestration;
  if (!state) {
    return {
      kind: "orchestration",
      action: "inspect",
      tone: "error",
      summary: `Orchestration #${entry.id} unavailable`,
    };
  }
  const status = item
    ? `work #${item.id} ${orchestrationWorkStatusLabel(item.status)}`
    : orchestrationStatusLabel(state.status);
  const text = item ? orchestrationWorkText(entry, item) : orchestrationControllerText(entry);
  return {
    kind: "orchestration",
    action: "inspect",
    tone: orchestrationTone(state, item),
    summary: `Orchestration #${entry.id} ${status} · ${orchestrationProgressLabel(state)}`,
    expanded: displayRows(text.split("\n"), item ? 12 : 9),
  };
}

export function formatOrchestrationInspection(entry: LoopEntry): string {
  return displayRows(orchestrationControllerText(entry).split("\n"), 10).join("\n");
}

/**
 * Whether live surfaces (status line, progress panel) should show this batch.
 * A finished or cancelled batch stays stored for inspection but is no longer in progress;
 * counting it would make the bar grow with every batch ever started.
 */
export function isOrchestrationInProgress(entry: LoopEntry): boolean {
  const status = entry.orchestration?.status;
  return (entry.status === "active" || entry.status === "paused") && (status === "active" || status === "needs_attention");
}

export function orchestrationWidgetSummary(entry: LoopEntry): string {
  const state = entry.orchestration;
  if (!state) return `#${entry.id} unavailable`;
  return `#${entry.id} ${orchestrationStatusLabel(state.status)} · ${orchestrationProgressLabel(state)}`;
}

export function orchestrationWakeHeading(id: string, state: OrchestrationState): string {
  if (state.status === "active") return `[pi-loop] Orchestration #${id} active.`;
  if (state.status === "completed") return `[pi-loop] Orchestration #${id} complete.`;
  if (state.status === "cancelled") return `[pi-loop] Orchestration #${id} cancelled.`;
  return `[pi-loop] Orchestration #${id} needs attention.`;
}
