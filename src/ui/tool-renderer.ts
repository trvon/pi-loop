import { type AgentToolResult, keyHint, type Theme, type ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Container, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { ToolDisplayDetails } from "../tools/tool-result.js";
import type { PanelLine } from "./progress-panel.js";

type ToolCallArgs = object;
const MAX_EXPANDED_VISUAL_LINES = 12;
// Collapsed cards stay at two lines: the summary and one dense preview.
const MAX_PREVIEW_LINES = 1;
const PREVIEW_TONES = new Set(["accent", "success", "warning", "error", "muted", "dim", "text"]);
// "Label: value" rows read faster when only the label recedes.
const LABELLED_ROW = /^([A-Z][A-Za-z ]{0,24}:)( .*)?$/s;

function singleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

class BoundedToolText extends Text {
  constructor(
    private readonly summary: string,
    private readonly expandedText?: string,
    private readonly overflowTemplate?: string,
    private readonly previewLines: string[] = [],
  ) {
    super("", 0, 0);
  }

  override render(width: number): string[] {
    const lines = [truncateToWidth(this.summary, width)];
    for (const line of this.previewLines) lines.push(truncateToWidth(line, width));
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

const CONTROL_BYTES = /[\u0000-\u001f\u007f-\u009f]/g;

function isPreview(preview: unknown): preview is PanelLine[] {
  return Array.isArray(preview) && preview.every((line) =>
    Array.isArray(line) && line.every((segment) =>
      typeof segment?.text === "string" && PREVIEW_TONES.has(segment.tone)));
}

// Details are persisted with the session, so a preview from an older or foreign
// version is untrusted: any malformed line or segment rejects the whole preview
// (summary alone), and control bytes never reach the terminal.
function stylePreview(preview: unknown, theme: Theme): string[] {
  if (!isPreview(preview)) return [];
  const lines: string[] = [];
  for (const line of preview.slice(0, MAX_PREVIEW_LINES)) {
    const text = line.map((segment) => theme.fg(segment.tone, segment.text.replace(CONTROL_BYTES, " "))).join("");
    if (line.some((segment) => segment.text.trim())) lines.push(text);
  }
  return lines;
}

function styleExpandedRow(line: string, theme: Theme): string {
  const match = LABELLED_ROW.exec(line);
  if (!match?.[1]) return theme.fg("dim", line);
  return theme.fg("muted", match[1]) + (match[2] ?? "");
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
    ? details.expanded.map((line) => styleExpandedRow(line, theme)).join("\n")
    : undefined;
  return new BoundedToolText(summary, expandedText, theme.fg("dim", "__OVERFLOW__"), stylePreview(details.preview, theme));
}
