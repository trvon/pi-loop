/** Plain-text tool result in the shape pi's registerTool expects. */
export type ToolDisplayKind = "loop" | "workflow" | "task" | "monitor";
export type ToolDisplayTone = "success" | "warning" | "error" | "info";

export interface ToolDisplayDetails {
  kind: ToolDisplayKind;
  action: string;
  tone: ToolDisplayTone;
  summary: string;
  expanded?: string[];
}

export function displayRows(rows: string[], limit = 8): string[] {
  if (rows.length <= limit) return rows;
  return [...rows.slice(0, limit), `… ${rows.length - limit} more`];
}

export function textResult(msg: string, details?: ToolDisplayDetails) {
  return { content: [{ type: "text" as const, text: msg }], details };
}
