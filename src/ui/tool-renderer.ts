import type { AgentToolResult, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { ToolDisplayDetails } from "../tools/tool-result.js";

type ToolCallArgs = object;

export function renderToolCall(label: string, summarize: (args: ToolCallArgs) => string) {
  return (args: ToolCallArgs, theme: Theme) => {
    const summary = summarize(args);
    const text = theme.fg("toolTitle", theme.bold(`${label} `)) + theme.fg("muted", summary);
    return new Text(text, 0, 0);
  };
}

export function toolArg(args: ToolCallArgs, name: string): unknown {
  return (args as Record<string, unknown>)[name];
}

export function renderToolResult(
  result: AgentToolResult<unknown>,
  { expanded, isPartial }: ToolRenderResultOptions,
  theme: Theme,
) {
  if (isPartial) return new Text(theme.fg("warning", "Working…"), 0, 0);

  const details = result.details as ToolDisplayDetails | undefined;
  if (!details) {
    const content = result.content[0];
    return new Text(content?.type === "text" ? content.text : "No result", 0, 0);
  }

  const color = details.tone === "success"
    ? "success"
    : details.tone === "warning"
      ? "warning"
      : details.tone === "error"
        ? "error"
        : "muted";
  const icon = details.tone === "success" ? "✓" : details.tone === "error" ? "✕" : details.tone === "warning" ? "!" : "•";
  let text = theme.fg(color, `${icon} ${details.summary}`);
  if (expanded && details.expanded?.length) {
    for (const line of details.expanded) text += `\n${theme.fg("dim", line)}`;
  }
  return new Text(text, 0, 0);
}
