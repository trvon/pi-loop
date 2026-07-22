import { describe, expect, it } from "vitest";
import { displayRows } from "../src/tools/tool-result.js";
import { renderToolCall, renderToolResult } from "../src/ui/tool-renderer.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as any;

describe("Pi tool renderer", () => {
  it("renders a compact result until the user expands it", () => {
    const result = {
      content: [{ type: "text" as const, text: "full model-facing result" }],
      details: {
        kind: "workflow" as const,
        action: "create",
        tone: "success" as const,
        summary: "Workflow #1 active · investigate · task #1",
        expanded: ["Goal: workflow smoke test", "Outcome: evidence_found"],
      },
    };

    const collapsed = renderToolResult(result, { expanded: false, isPartial: false }, theme);
    const expanded = renderToolResult(result, { expanded: true, isPartial: false }, theme);

    expect(collapsed.render(120).map((line) => line.trimEnd())).toEqual(["✓ Workflow #1 active · investigate · task #1"]);
    expect(expanded.render(120).map((line) => line.trimEnd())).toEqual([
      "✓ Workflow #1 active · investigate · task #1",
      "Goal: workflow smoke test",
      "Outcome: evidence_found",
    ]);
  });

  it("renders a concise call label", () => {
    const render = renderToolCall("Monitor", () => "start · npm test");
    expect(render({}, theme).render(120).map((line) => line.trimEnd())).toEqual(["Monitor start · npm test"]);
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

  it("bounds display metadata for large lists", () => {
    const rows = Array.from({ length: 200 }, (_value, index) => `#${index + 1}`);
    expect(displayRows(rows)).toEqual([
      "#1", "#2", "#3", "#4", "#5", "#6", "#7", "#8", "… 192 more",
    ]);
  });
});
