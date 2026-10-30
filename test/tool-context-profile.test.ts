import { access, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { normalizeContext, type TranscriptContext } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNativeSession } from "../benchmarks/native-session.js";
import { CONTEXT_CASES, profileContextCase, runToolContextProfile } from "../benchmarks/profile-tool-context.js";
import {
  appendRequestCapture,
  boundedJson,
  captureRequest,
  contextOptions,
  MAX_CAPTURE_BYTES,
  MAX_CASE_REQUESTS,
  type RequestCapture,
  repeatedRequestSummary,
  sha256,
  textSize,
  toolCost,
} from "../benchmarks/tool-context-report.js";

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function directory() {
  const dir = await mkdtemp(join(tmpdir(), "tool-context-test-"));
  dirs.push(dir);
  return dir;
}

function context(text = "Fixture instructions"): TranscriptContext {
  return normalizeContext({ systemPrompt: text, messages: [] });
}

describe("tool-context profile expectations", () => {
  it("parses only the bounded fixed-matrix CLI and rejects misuse before creating output", async () => {
    expect(contextOptions([])).toEqual({ help: false, out: resolve(".artifacts/profiles/tool-context") });
    expect(contextOptions(["--out", "my profiles"])).toEqual({ help: false, out: resolve("my profiles") });
    expect(contextOptions(["--help"]).help).toBe(true);
    expect(contextOptions(["--context", "compact"]).contextProfile).toBe("compact");
    expect(contextOptions(["--context", "full"]).contextProfile).toBe("full");
    for (const args of [["--context"], ["--context", "unknown"], ["--context", "compact", "--context", "full"]]) expect(() => contextOptions(args)).toThrow();
    for (const args of [["--out"], ["--out", ""], ["--out", " "], ["--out", "--help"], ["--out", "a", "--out", "b"], ["--budget", "-1"], ["--mode", "off"], ["--help", "--out", "a"]]) {
      expect(() => contextOptions(args)).toThrow();
    }
    const dir = await directory();
    const output = join(dir, "must-not-exist");
    await expect(runToolContextProfile(["--out", output, "--unknown"])).rejects.toThrow();
    await expect(access(output)).rejects.toThrow();
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    expect(await runToolContextProfile(["--help"])).toBeNull();
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining("Usage:"));
  });

  it("counts UTF-16 code units and UTF-8 bytes without manufacturing token measurements", () => {
    expect(textSize("é😀")).toEqual({ chars: 3, bytes: 6 });
    const captured = captureRequest(context("é😀"), "/fixture", "initial");
    expect(captured.metrics.instructions).toEqual({ chars: 3, bytes: 6 });
    expect(captured.metrics.transcript.bytes).toBe(Buffer.byteLength(JSON.stringify(context("é😀").messages)));
    expect(captured.metrics.providerInputTokens).toBeNull();
    expect(captured.metrics.providerCacheReadTokens).toBeNull();
    expect(captured.metrics.providerCacheWriteTokens).toBeNull();
  });

  it("counts nested schema description copy without treating examples or enum values as schema nodes", () => {
    const schema = {
      type: "object", description: "root",
      properties: {
        label: { anyOf: [{ type: "string", description: "é😀" }, { type: "null" }] },
        rows: { type: "array", items: { type: "string", description: "item" } },
        description: { type: "string", description: "field" },
      },
      $defs: { rule: { description: "def" } },
      examples: [{ description: "not schema copy" }],
      enum: [{ description: "also not schema copy" }],
    };
    const before = structuredClone(schema);
    const descriptionCopy = "root\né😀\nitem\nfield\ndef";
    expect(toolCost({ name: "Fixture", description: "tool", parameters: schema })).toMatchObject({
      parameters: { bytes: Buffer.byteLength(JSON.stringify(schema)) },
      parameterDescriptions: textSize(descriptionCopy),
    });
    expect(schema).toEqual(before);
    expect(toolCost({ name: "Empty", description: "", parameters: {} })).toMatchObject({ parameterDescriptions: { chars: 0, bytes: 0 } });
  });

  it("measures before replacing only fixture workspace strings, including JSON-escaped paths", () => {
    const workspace = String.raw`C:\fixture "space" é`;
    const original = context(`Work in ${workspace}; preserve other text.`);
    const captured = captureRequest(original, workspace, "initial");
    expect(captured.metrics.transcript.bytes).toBe(Buffer.byteLength(JSON.stringify(original.messages)));
    expect(JSON.stringify(captured.messages)).toContain("<fixture-workspace>");
    expect(JSON.stringify(captured.messages)).not.toContain("fixture \\");
    expect(original.messages[0]).toMatchObject({ role: "system", content: `Work in ${workspace}; preserve other text.` });
  });

  it("fails closed at exact artifact, capture, and request-count limits without dropping data", () => {
    expect(boundedJson(0, 2)).toBe("0\n");
    expect(() => boundedJson(0, 1)).toThrow(/nothing was truncated/);
    expect(() => captureRequest(context("x".repeat(MAX_CAPTURE_BYTES)), "/fixture", "initial")).toThrow(/limit/);
    const captured: RequestCapture[] = [];
    for (let i = 0; i < MAX_CASE_REQUESTS; i++) appendRequestCapture(captured, context(), "/fixture", "initial");
    expect(() => appendRequestCapture(captured, context(), "/fixture", "initial")).toThrow(/request limit/);
    expect(captured).toHaveLength(MAX_CASE_REQUESTS);
  });

  it("reports repeated definitions separately from transcript growth and unknown cache reuse", () => {
    const first = captureRequest(context(), "/fixture", "initial");
    const repeated = captureRequest(normalizeContext({ messages: [...context().messages, { role: "user", content: "Again", timestamp: 0 }] }), "/fixture", "repeat");
    expect(repeatedRequestSummary([first, repeated])).toMatchObject({ declarationsUnchanged: true, instructionsUnchanged: true, cacheReuse: null });
    expect(repeatedRequestSummary([first, repeated]).transcriptGrowthBytes).toBeGreaterThan(0);
    expect(() => repeatedRequestSummary([first])).toThrow(/exactly one/);
    expect(() => repeatedRequestSummary([first, first, repeated])).toThrow(/exactly one/);
  });

  it("cleans up native fixture failures and restores the caller's storage environment", async () => {
    const previous = { scope: process.env.PI_LOOP_SCOPE, loop: process.env.PI_LOOP };
    let workspace = "";
    const fixture = await createNativeSession({
      onRequest(_context, cwd) {
        workspace = cwd;
        throw new Error("capture failure control");
      },
    });
    try {
      expect({ scope: process.env.PI_LOOP_SCOPE, loop: process.env.PI_LOOP }).toEqual(previous);
      await expect(fixture.prompt()).rejects.toThrow(/capture failure control/);
    } finally { await fixture.close(); }
    expect(workspace).not.toBe("");
    await expect(access(workspace)).rejects.toThrow();
    await fixture.close();
  });

  it("writes all six actual SDK cases, hashes bounded captures, and preserves authority", async () => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const dir = await directory();
    const result = await runToolContextProfile(["--out", dir]);
    expect(result).not.toBeNull();
    const { metadata, out } = result!;
    expect(metadata.complete).toBe(true);
    expect(metadata.sdk).toBe("1.4.0");
    expect(metadata.fixture).toEqual({ nativeModelsApi: false, sdkDefaultTools: true, externalExtensions: false, operatorContext: false });
    expect(metadata.source.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(metadata.source.files.some(file => file.path === "src/index.ts")).toBe(true);
    expect(metadata.requestedCases).toEqual(CONTEXT_CASES.map(spec => spec.name));
    expect(metadata.cases).toHaveLength(6);
    expect(metadata.captures).toHaveLength(6);
    expect((await readdir(out)).sort()).toEqual([...CONTEXT_CASES.map(spec => `${spec.name}.requests.json`), "report.json"].sort());
    for (const artifact of metadata.captures) {
      const raw = await readFile(join(out, artifact.file), "utf8");
      expect(Buffer.byteLength(raw)).toBe(artifact.bytes);
      expect(sha256(raw)).toBe(artifact.sha256);
      expect(raw).not.toContain("pi-loop-codemode-");
      expect(raw).not.toContain("fixture-not-a-secret");
    }
    for (const profile of metadata.cases) {
      expect(profile.emptyStateVerified).toBe(true);
      expect(profile.activationUnchanged).toBe(true);
      expect(profile.registered.filter(tool => tool.piLoop).every(tool => tool.exposure === "direct")).toBe(true);
      expect(profile.repeat).toMatchObject({ declarationsUnchanged: true, instructionsUnchanged: true, cacheReuse: null });
      const enabled = profile.active.includes("codemode");
      expect(profile.requests).toHaveLength(enabled ? 6 : 4);
      expect(profile.discovery === null).toBe(!enabled);
      if (profile.name.startsWith("only-")) {
        expect(profile.declared).toEqual(["codemode"]);
        expect(profile.callable).toContain("TaskCreate");
      } else {
        expect(profile.declared).toEqual(expect.arrayContaining(["TaskCreate", "WorkflowCreate", "LoopCreate"]));
      }
      for (const request of profile.requests) expect(request.providerInputTokens).toBeNull();
    }
    const zero = metadata.cases.find(profile => profile.name === "only-zero")!;
    const normal = metadata.cases.find(profile => profile.name === "only-default")!;
    expect(zero.requests[0]!.declarations.bytes).toBeLessThan(normal.requests[0]!.declarations.bytes);
    expect(zero.requests[0]!.observedInlineHeadings).toEqual([]);
    expect(normal.requests[0]!.observedInlineHeadings.length).toBeGreaterThan(0);
    expect(zero.discovery!.content.bytes).toBeGreaterThan(0);
  });

  it("keeps completed-case captures when a later case fails", async () => {
    const dir = await directory();
    const failure = new Error("later case failure");
    await expect(runToolContextProfile(["--out", dir], async spec => {
      if (spec.name === "disabled") return profileContextCase(spec);
      throw failure;
    })).rejects.toBe(failure);
    const runs = await readdir(dir);
    const report = JSON.parse(await readFile(join(dir, runs[0]!, "report.json"), "utf8"));
    expect(report.complete).toBe(false);
    expect(report.cases.map((entry: { name: string }) => entry.name)).toEqual(["disabled"]);
    expect(report.requestedCases).toHaveLength(6);
    expect(await readdir(join(dir, runs[0]!))).toEqual(expect.arrayContaining(["disabled.requests.json", "report.json"]));
    const raw = await readFile(join(dir, runs[0]!, "disabled.requests.json"), "utf8");
    expect(sha256(raw)).toBe(report.captures[0].sha256);
  });

  it("retains an incomplete report and propagates a failed case instead of claiming success", async () => {
    const dir = await directory();
    const failure = new Error("case failure control");
    await expect(runToolContextProfile(["--out", dir], async () => { throw failure; })).rejects.toBe(failure);
    const runs = await readdir(dir);
    expect(runs).toHaveLength(1);
    const report = JSON.parse(await readFile(join(dir, runs[0]!, "report.json"), "utf8"));
    expect(report).toMatchObject({ complete: false, failure: "Error", cases: [], captures: [] });
    expect(report.requestedCases).toHaveLength(6);
  });
});
