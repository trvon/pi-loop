/** Plain-text tool result in the shape pi's registerTool expects. */
export function textResult(msg: string) {
  return { content: [{ type: "text" as const, text: msg }], details: undefined };
}
