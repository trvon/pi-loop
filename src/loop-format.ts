import type { Trigger, WorkflowTransitionRecord } from "./types.js";

export type TriggerFormatStyle = "command" | "create" | "list" | "notification";

/** Single-line wake/list rendering of the last workflow transition; evidence is collapsed so it cannot break line-oriented messages. */
export function formatLastTransitionLines(lastTransition: WorkflowTransitionRecord): string[] {
  const { from, to, outcome, evidence } = lastTransition;
  const lines = [`Last transition: ${from} → ${to} via ${outcome}`];
  if (evidence) lines.push(`Evidence: ${evidence.replace(/\s+/g, " ")}`);
  if (lastTransition.admission) {
    const admission = lastTransition.admission;
    const provider = admission.provider.replace(/\s+/g, " ");
    const subject = admission.subject.replace(/\s+/g, " ");
    const fact = admission.fact.replace(/\s+/g, " ");
    const observations = admission.observations.map((observation) => observation.replace(/\s+/g, " ")).join(", ");
    lines.push(`Admission: ${admission.claimClass} · ${provider}:${subject}.${fact} = ${JSON.stringify(admission.expected)} · ${observations}`);
  }
  return lines;
}

export function formatTrigger(trigger: Trigger | string, style: TriggerFormatStyle = "list"): string {
  if (typeof trigger === "string") return trigger;

  if (trigger.type === "cron") {
    return style === "create" || style === "notification"
      ? `schedule: ${trigger.schedule}`
      : `cron: ${trigger.schedule}`;
  }

  if (trigger.type === "event") return `event: ${trigger.source}`;

  if (trigger.type === "dynamic") return "dynamic";

  if (style === "command") return `hybrid: ${trigger.cron}`;
  if (style === "create") return `hybrid: cron ${trigger.cron} + event ${trigger.event.source}`;
  if (style === "notification") return "hybrid";
  return `hybrid: ${trigger.cron} + ${trigger.event.source}`;
}
