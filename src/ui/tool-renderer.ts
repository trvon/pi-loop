import { type AgentToolResult, keyHint, type Theme, type ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
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

export function hideToolTranscript() {
  return new Container();
}

function toneAppearance(tone: ToolDisplayDetails["tone"]): { color: "success" | "warning" | "error" | "muted"; icon: string } {
  switch (tone) {
    case "success": return { color: "success", icon: "✓" };
    case "warning": return { color: "warning", icon: "!" };
    case "error": return { color: "error", icon: "✕" };
    default: return { color: "muted", icon: "•" };
  }
}

export function renderToolResult(
  result: AgentToolResult<unknown>,
  { expanded, isPartial }: ToolRenderResultOptions,
  theme: Theme,
  context?: { isError?: boolean },
) {
  const details = result.details as ToolDisplayDetails | undefined;
  if (isPartial) {
    const progress = details?.summary ? `… ${details.summary}` : "Working…";
    return new Text(theme.fg("warning", progress), 0, 0);
  }

  if (!details) {
    const content = result.content[0];
    const output = content?.type === "text" ? content.text : "No result";
    return new Text(context?.isError ? theme.fg("error", `✕ ${output}`) : output, 0, 0);
  }

  const tone = context?.isError ? "error" : details.tone;
  const { color, icon } = toneAppearance(tone);
  let text = theme.fg(color, `${icon} ${details.summary}`);
  if (!expanded && details.expandable) {
    text += theme.fg("dim", ` · ${keyHint("app.tools.expand", "to expand")}`);
  }
  if (expanded && details.expanded?.length) {
    for (const line of details.expanded) text += `\n${theme.fg("dim", line)}`;
  }
  return new Text(text, 0, 0);
}
