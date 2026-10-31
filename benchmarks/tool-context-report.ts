import { createHash } from "node:crypto";
import { resolve, win32 } from "node:path";
import { getCurrentSystemPrompt, getCurrentTools, type Tool, type TranscriptContext } from "@earendil-works/pi-ai";

export const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;
export const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
export const MAX_CASE_REQUESTS = 12;
export const isLoopTool = (name: string) => /^(Loop|Task|Workflow|Monitor|Orchestration)/.test(name);

export function textSize(text: string) {
  return { chars: text.length, bytes: Buffer.byteLength(text, "utf8") };
}

export function jsonSize(value: unknown) {
  return textSize(JSON.stringify(value));
}

export function sha256(text: string) {
  return createHash("sha256").update(text).digest("hex");
}

export function boundedJson(value: unknown, limit = MAX_ARTIFACT_BYTES): string {
  const json = `${JSON.stringify(value, null, 2)}\n`;
  if (textSize(json).bytes > limit) throw new Error(`Artifact exceeds ${limit} bytes; nothing was truncated`);
  return json;
}

export function contextOptions(args: string[]) {
  let out = resolve(".artifacts/profiles/tool-context");
  let supplied = false;
  let contextProfile: "full" | "compact" | undefined;
  if (args.length === 1 && args[0] === "--help") return { help: true, out };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--context" && contextProfile === undefined) {
      const value = args[++i];
      if (value !== "full" && value !== "compact") throw new Error("--context requires full or compact");
      contextProfile = value;
      continue;
    }
    if (args[i] !== "--out" || supplied) throw new Error(`Unknown or duplicate option: ${args[i]}`);
    const value = args[++i];
    if (!value?.trim() || value.startsWith("--")) throw new Error("--out requires a directory");
    out = resolve(value);
    supplied = true;
  }
  return { help: false, out, ...(contextProfile ? { contextProfile } : {}) };
}

function schemaDescriptions(schema: unknown): string[] {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) return [];
  const node = schema as Record<string, unknown>;
  const descriptions = typeof node.description === "string" ? [node.description] : [];
  // Only schema-bearing keywords count; enum/example objects are instance data.
  for (const [key, value] of Object.entries(node)) {
    if (["properties", "patternProperties", "$defs", "definitions", "dependentSchemas", "dependencies"].includes(key)) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        for (const child of Object.values(value)) descriptions.push(...schemaDescriptions(child));
      }
    } else if (["allOf", "anyOf", "oneOf", "prefixItems"].includes(key) || (key === "items" && Array.isArray(value))) {
      if (Array.isArray(value)) for (const child of value) descriptions.push(...schemaDescriptions(child));
    } else if (["items", "additionalItems", "additionalProperties", "contains", "not", "if", "then", "else", "propertyNames", "unevaluatedProperties", "unevaluatedItems", "contentSchema"].includes(key)) {
      descriptions.push(...schemaDescriptions(value));
    }
  }
  return descriptions;
}

export function toolCost(tool: Tool) {
  return {
    name: tool.name,
    piLoop: isLoopTool(tool.name),
    description: textSize(tool.description),
    parameters: jsonSize(tool.parameters),
    parameterDescriptions: textSize(schemaDescriptions(tool.parameters).join("\n")),
    declaration: jsonSize(tool),
  };
}

export type ProfileStage = "initial" | "repeat" | "discovery" | "read";

export function captureRequest(context: TranscriptContext, workspace: string, stage: ProfileStage) {
  const raw = JSON.stringify(context.messages);
  if (textSize(raw).bytes > MAX_CAPTURE_BYTES) throw new Error("Request capture exceeds byte limit; nothing was truncated");
  const tools = getCurrentTools(context.messages);
  const instructions = getCurrentSystemPrompt(context.messages);
  const declarations = JSON.stringify(tools);
  const results = context.messages.filter(message => message.role === "toolResult");
  // The SDK renders Windows cwd with forward slashes; retain POSIX literal backslashes.
  const windowsRoot = win32.parse(workspace).root;
  const windowsAbsolute = windowsRoot.length > 2 && (windowsRoot[1] === ":" || windowsRoot.startsWith("\\\\"));
  const workspaceForms = [...new Set([workspace, ...(windowsAbsolute ? [workspace.replaceAll("\\", "/")] : [])])];
  let messages: TranscriptContext["messages"];
  try {
    messages = JSON.parse(raw, (_key, value: unknown) =>
      typeof value === "string" ? workspaceForms.reduce((text, path) => text.replaceAll(path, "<fixture-workspace>"), value) : value);
  } catch (cause) {
    throw new Error("Unable to snapshot native request", { cause });
  }
  // Counts describe the original SDK boundary; saved fixture paths are not operator paths.
  return {
    stage,
    metrics: {
      transcript: textSize(raw),
      instructions: textSize(instructions),
      instructionSha256: sha256(instructions),
      declarations: textSize(declarations),
      declarationSha256: sha256(declarations),
      toolResults: jsonSize(results),
      resultCount: results.length,
      tools: tools.map(toolCost),
      observedInlineHeadings: [...(tools.find(tool => tool.name === "codemode")?.description ?? "").matchAll(/^### `([^`]+)`/gm)].flatMap(match => match[1] === undefined ? [] : [match[1]]),
      providerInputTokens: null,
      providerCacheReadTokens: null,
      providerCacheWriteTokens: null,
    },
    messages,
  };
}

export type RequestCapture = ReturnType<typeof captureRequest>;

export function appendRequestCapture(captures: RequestCapture[], context: TranscriptContext, workspace: string, stage: ProfileStage) {
  if (captures.length >= MAX_CASE_REQUESTS) throw new Error("Case exceeds request limit; nothing was truncated");
  captures.push(captureRequest(context, workspace, stage));
}

export function requestSummary(capture: RequestCapture) {
  return { stage: capture.stage, ...capture.metrics };
}

export function repeatedRequestSummary(captures: RequestCapture[]) {
  const first = captures.filter(capture => capture.stage === "initial");
  const repeat = captures.filter(capture => capture.stage === "repeat");
  const initial = first[0];
  const repeated = repeat[0];
  if (first.length !== 1 || repeat.length !== 1 || !initial || !repeated) throw new Error("Expected exactly one initial and repeated request");
  const a = initial.metrics;
  const b = repeated.metrics;
  return {
    declarationsUnchanged: a.declarationSha256 === b.declarationSha256,
    instructionsUnchanged: a.instructionSha256 === b.instructionSha256,
    transcriptGrowthBytes: b.transcript.bytes - a.transcript.bytes,
    cacheReuse: null,
  };
}
