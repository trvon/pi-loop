import { type AgentToolResult, keyHint, type Theme, type ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Container, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { ToolDisplayDetails } from "../tools/tool-result.js";

type ToolCallArgs = object;
const MAX_EXPANDED_VISUAL_LINES = 12;

function singleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

class BoundedToolText extends Text {
  constructor(
    private readonly summary: string,
    private readonly expandedText?: string,
    private readonly overflowTemplate?: string,
  ) {
    super("", 0, 0);
  }

  override render(width: number): string[] {
    const lines = [truncateToWidth(this.summary, width)];
    if (!this.expandedText) return lines;
    const visualLines = new Text(this.expandedText, 0, 0).render(width);
    lines.push(...visualLines.slice(0, MAX_EXPANDED_VISUAL_LINES));
    if (visualLines.length > MAX_EXPANDED_VISUAL_LINES) {
      const overflow = `… ${visualLines.length - MAX_EXPANDED_VISUAL_LINES} more visual lines`;
      lines.push(truncateToWidth(this.overflowTemplate?.replace("__OVERFLOW__", overflow) ?? overflow, width));
    }
    return lines;
  }
}

export function renderToolCall(label: string, summarize: (args: ToolCallArgs) => string) {
  return (args: ToolCallArgs, theme: Theme) => {
    const summary = singleLine(summarize(args));
    const text = theme.fg("toolTitle", theme.bold(`${label} `)) + theme.fg("muted", summary);
    return new BoundedToolText(text);
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
    const progress = details?.summary ? `… ${singleLine(details.summary)}` : "Working…";
    return new Text(theme.fg("warning", progress), 0, 0);
  }

  if (!details) {
    const content = result.content[0];
    const output = content?.type === "text" ? content.text : "No result";
    return new Text(context?.isError ? theme.fg("error", `✕ ${output}`) : output, 0, 0);
  }

  const tone = context?.isError ? "error" : details.tone;
  const { color, icon } = toneAppearance(tone);
  let summary = theme.fg(color, `${icon} ${singleLine(details.summary)}`);
  if (!expanded && details.expandable) {
    summary += theme.fg("dim", ` · ${keyHint("app.tools.expand", "to expand")}`);
  }
  const expandedText = expanded && details.expanded?.length
    ? details.expanded.map((line) => theme.fg("dim", line)).join("\n")
    : undefined;
  return new BoundedToolText(summary, expandedText, theme.fg("dim", "__OVERFLOW__"));
}
