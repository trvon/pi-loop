import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { describe, expect, it, vi } from "vitest";
import { COMPACT_GUIDE, compactParameterSchema, createToolContextRegistration } from "../src/tools/tool-context.js";
import { createMockPi } from "./helpers/mock-pi.js";

function definition() {
  return {
    name: "TaskCreate", label: "Fixture", description: "Original tool description.",
    promptSnippet: "Original snippet", promptGuidelines: ["Original ownership rule"],
    parameters: Type.Object({ description: Type.String({ description: "Parameter documentation", minLength: 1 }) }),
    exposure: "direct" as const,
    annotations: { readOnlyHint: false },
    outputSchema: Type.String(),
    prepareArguments: (args: unknown) => args as { description: string },
    execute: vi.fn(async () => ({ content: [{ type: "text" as const, text: "unchanged execution" }], details: {} })),
  } satisfies ToolDefinition;
}

describe("compact registration metadata invariants", () => {
  it.each(["full", "", "COMPACT", "compact ", "other"])("forwards original definitions and installs no hook in %j", profile => {
    const mock = createMockPi();
    const tool = definition();
    createToolContextRegistration(mock.pi, profile)(tool);
    expect(mock.toolMap.size).toBe(1);
    expect(mock.toolMap.get(tool.name)).toBe(tool);
    expect(mock.extensionHandlers.size).toBe(0);
  });

  it("changes only input documentation metadata, with original full contracts recoverable", async () => {
    const mock = createMockPi();
    mock.pi.getActiveTools = () => [...mock.toolMap.keys()];
    const tool = definition();
    const before = JSON.stringify(tool);
    createToolContextRegistration(mock.pi, "compact")(tool);
    const compact = mock.toolMap.get(tool.name)!;
    expect(compact.description).not.toBe(tool.description);
    expect(compact.promptSnippet).toBeUndefined();
    expect(compact.promptGuidelines).toBeUndefined();
    expect(compact.parameters).toEqual(Type.Object({ description: Type.String({ minLength: 1 }) }));
    for (const key of ["execute", "prepareArguments", "outputSchema", "annotations", "exposure", "label"] as const) {
      expect(compact[key]).toBe(tool[key]);
    }
    const help = mock.toolMap.get("LoopHelp")!;
    expect(help.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
    const result = await help.execute!("help", { tool: tool.name });
    expect(JSON.parse(result.content[0].text)).toEqual({
      name: tool.name, description: tool.description, parameters: tool.parameters,
      promptSnippet: tool.promptSnippet, promptGuidelines: tool.promptGuidelines,
      outputSchema: tool.outputSchema, annotations: tool.annotations, exposure: tool.exposure,
    });
    expect(JSON.stringify(tool)).toBe(before);
    expect(tool.execute).not.toHaveBeenCalled();
    expect(mock.sentMessages).toEqual([]);
    expect(mock.sentUserMessages).toEqual([]);
  });

  it("retains schema symbols, constraints, instance objects, references and description-named parameters", () => {
    const schema = Type.Object({
      description: Type.String({ description: "copy", minLength: 1, maxLength: 4, pattern: "^[a-z]+$" }),
      count: Type.Optional(Type.Integer({ description: "copy", minimum: 0, maximum: 2, default: 1 })),
      nested: Type.Optional(Type.Array(Type.Union([Type.String({ minLength: 2, description: "copy" }), Type.Boolean({ description: "copy" })]), { maxItems: 2, description: "copy" })),
    }, { additionalProperties: false, description: "root", examples: [{ description: "instance" }], default: { description: "instance" } });
    const marker = Symbol("schema metadata");
    Object.defineProperty(schema, marker, { value: "keep", enumerable: false });
    Object.freeze(schema.properties.description);
    Object.freeze(schema);
    const before = JSON.stringify(schema);
    const compact = compactParameterSchema(schema);
    expect(compact).not.toBe(schema);
    expect(Object.getOwnPropertyDescriptor(compact, marker)?.value).toBe("keep");
    expect(Object.hasOwn(compact, "description")).toBe(false);
    expect(Object.hasOwn(compact.properties.description, "description")).toBe(false);
    expect(Reflect.get(compact.properties.description, "minLength")).toBe(1);
    expect(Reflect.get(compact, "examples")).toBe(Reflect.get(schema, "examples"));
    expect(Reflect.get(compact, "default")).toBe(Reflect.get(schema, "default"));
    const fullValidator = Compile(schema);
    const compactValidator = Compile(compact);
    expect(fullValidator.Check({ description: "abc" })).toBe(true);
    const values = [{ description: "abc" }, { description: "a", count: 2, nested: [true, "ab"] }, {},
      { description: "" }, { description: "abcde" }, { description: "ABC" }, { description: 1 },
      { description: "a", count: -1 }, { description: "a", count: 3 }, { description: "a", count: 0.5 },
      { description: "a", nested: ["a"] }, { description: "a", nested: [true, false, true] }, { description: "a", extra: true }];
    for (const value of values) expect(compactValidator.Check(value)).toBe(fullValidator.Check(value));
    expect(JSON.stringify(schema)).toBe(before);
    const reference = { ...Type.Object({ value: Type.String() }), $ref: "#/$defs/item", $defs: { item: Type.String({ description: "copy" }) },
      enum: [{ description: "literal" }], const: { description: "constant" }, unknownKeyword: { description: "opaque" } };
    const copy = compactParameterSchema(reference);
    expect(copy.$ref).toBe(reference.$ref);
    expect(Object.hasOwn(copy.$defs.item, "description")).toBe(false);
    expect(copy.enum).toBe(reference.enum);
    expect(copy.const).toBe(reference.const);
    expect(copy.unknownKeyword).toBe(reference.unknownKeyword);
  });

  it("adds one stable guide without replacing other structured prompt sections, with an older-host fallback", async () => {
    const mock = createMockPi();
    createToolContextRegistration(mock.pi, "compact");
    const sections = { other: "Keep existing guidance" } as Record<string, string>;
    await mock.emitExtension("before_agent_start", { systemPromptOptions: { sections } }, {});
    expect(sections).toEqual({ other: "Keep existing guidance", pi_loop: COMPACT_GUIDE });
    expect(Buffer.byteLength(COMPACT_GUIDE, "utf8")).toBeLessThanOrEqual(1200);
    await mock.emitExtension("before_agent_start", { systemPromptOptions: { sections } }, {});
    expect(sections.pi_loop).toBe(COMPACT_GUIDE);
    const handler = mock.extensionHandlers.get("before_agent_start")![0]!;
    expect(await handler({ systemPrompt: "Existing prompt" }, {})).toEqual({ systemPrompt: `Existing prompt\n\n${COMPACT_GUIDE}` });
  });
});
