import type { Trigger } from "./types.js";

export type TriggerFormatStyle = "command" | "create" | "list" | "notification";

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
