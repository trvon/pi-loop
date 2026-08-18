import { readFileSync, rmSync } from "node:fs";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { displayRows, textResult } from "../src/tools/tool-result.js";
import { hideToolTranscript, renderToolCall, renderToolResult, toolArg } from "../src/ui/tool-renderer.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as any;

describe("Pi tool renderer", () => {
  beforeAll(() => initTheme("dark"));
  it("renders a compact result until the user expands it", () => {
    const result = {
      content: [{ type: "text" as const, text: "full model-facing result" }],
      details: {
        kind: "workflow" as const,
        action: "create",
        tone: "success" as const,
        summary: "Workflow #1 active · investigate · task #1",
        expanded: ["Goal: workflow smoke test", "Outcome: evidence_found"],
        expandable: true,
      },
    };

    const collapsed = renderToolResult(result, { expanded: false, isPartial: false }, theme);
    const expanded = renderToolResult(result, { expanded: true, isPartial: false }, theme);

    const collapsedLines = collapsed.render(120).map((line) => line.trimEnd());
    expect(collapsedLines).toHaveLength(1);
    expect(collapsedLines[0]).toContain("✓ Workflow #1 active · investigate · task #1");
    expect(collapsedLines[0]).toContain("expand");
    expect(expanded.render(120).map((line) => line.trimEnd())).toEqual([
      "✓ Workflow #1 active · investigate · task #1",
      "Goal: workflow smoke test",
      "Outcome: evidence_found",
    ]);
  });

  it("keeps meaningful progress identity while a result is partial", () => {
    const component = renderToolResult({
      content: [{ type: "text", text: "starting monitor" }],
      details: {
        kind: "monitor",
        action: "create",
        tone: "info",
        summary: "Monitor #4 starting · npm test",
      },
    }, { expanded: false, isPartial: true }, theme);

    expect(component.render(40).join("\n")).toContain("Monitor #4 starting");
  });

  it("shows unexpected tool errors even without display metadata", () => {
    const component = (renderToolResult as any)(
      { content: [{ type: "text", text: "process spawn failed" }] },
      { expanded: false, isPartial: false },
      theme,
      { isError: true } as any,
    );

    expect(component.render(80).join("\n")).toContain("✕ process spawn failed");
  });

  it("bounds expanded details by rendered terminal lines", () => {
    const component = renderToolResult({
      content: [{ type: "text", text: "model content" }],
      details: {
        kind: "workflow",
        action: "create",
        tone: "success",
        summary: "Workflow #1 active",
        expanded: ["A very long workflow instruction ".repeat(30)],
        expandable: true,
      },
    }, { expanded: true, isPartial: false }, theme);

    const lines = component.render(24);
    expect(lines.length).toBeLessThanOrEqual(14);
    expect(lines.at(-1)).toContain("more visual lines");
  });

  it("normalizes and width-bounds call summaries onto one row", () => {
    const render = renderToolCall("Monitor", () => `start · first line\n${"second line ".repeat(20)}`);
    const lines = render({}, theme).render(32);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Monitor start · first line");
    expect(visibleWidth(lines[0])).toBeLessThanOrEqual(32);
  });

  it("renders a concise call label", () => {
    const render = renderToolCall("Monitor", () => "start · npm test");
    expect(render({}, theme).render(120).map((line) => line.trimEnd())).toEqual(["Monitor start · npm test"]);
  });

  it("renders no transcript content for hidden tools", () => {
    expect(hideToolTranscript().render(120)).toEqual([]);
  });

  it("reads a named tool argument", () => {
    expect(toolArg({ monitorId: "4" }, "monitorId")).toBe("4");
  });

  it("does not read expanded rows while a result stays collapsed", () => {
    const details: any = {
      kind: "task",
      action: "list",
      tone: "info",
      summary: "200 tasks · 200 pending · 0 active",
    };
    Object.defineProperty(details, "expanded", {
      get: () => {
        throw new Error("collapsed renderer must not read expanded rows");
      },
    });

    const component = renderToolResult(
      { content: [{ type: "text", text: "full task list" }], details },
      { expanded: false, isPartial: false },
      theme,
    );

    expect(component.render(120).map((line) => line.trimEnd())).toEqual(["• 200 tasks · 200 pending · 0 active"]);
  });

  it("bounds display metadata by physical lines", () => {
    expect(displayRows(["first\nsecond", "third"], 2)).toEqual([
      "first", "second", "… 1 more",
    ]);
  });

  it("truncates oversized model content while preserving retrievable full output", () => {
    const fullContent = Array.from({ length: 2100 }, (_value, index) => `line ${index + 1}`).join("\n");
    const result = textResult(fullContent);
    expect(result.content[0].text.split("\n").length).toBeLessThanOrEqual(2002);
    expect(result.content[0].text).toContain("Output truncated");
    const fullOutputPath = result.content[0].text.match(/Full output: (.+)]$/)?.[1];
    expect(fullOutputPath).toBeDefined();
    try {
      expect(readFileSync(fullOutputPath!, "utf8")).toBe(fullContent);
    } finally {
      if (fullOutputPath) rmSync(fullOutputPath, { force: true });
    }
  });

  it("bounds display metadata for large lists", () => {
    const rows = Array.from({ length: 200 }, (_value, index) => `#${index + 1}`);
    expect(displayRows(rows)).toEqual([
      "#1", "#2", "#3", "#4", "#5", "#6", "#7", "#8", "… 192 more",
    ]);
  });
});
