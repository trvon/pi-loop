import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PI_AI_VERSION } from "@earendil-works/pi-ai";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { createNativeSession } from "./native-session.js";
import {
  appendRequestCapture,
  boundedJson,
  contextOptions,
  isLoopTool,
  jsonSize,
  MAX_ARTIFACT_BYTES,
  MAX_CAPTURE_BYTES,
  MAX_CASE_REQUESTS,
  type ProfileStage,
  type RequestCapture,
  repeatedRequestSummary,
  requestSummary,
  sha256,
  textSize,
} from "./tool-context-report.js";

export const CONTEXT_CASES = [
  { name: "disabled" },
  { name: "inactive", mode: "only", inactive: true },
  { name: "on-default", mode: "on", inlineBudget: 3000 },
  { name: "on-zero", mode: "on", inlineBudget: 0 },
  { name: "only-default", mode: "only", inlineBudget: 3000 },
  { name: "only-zero", mode: "only", inlineBudget: 0 },
] as const;

export type ContextCase = (typeof CONTEXT_CASES)[number] & { contextProfile?: "compact" };

const discoveryScript = (compact: boolean) => `// @options: {"max_output_tokens": 12000}
return {
  names: ALL_TOOLS.map(t => t.name),
  controllers: await Promise.all(["LoopCreate", "TaskCreate", "WorkflowCreate"].map(name => ${compact ? "tools.LoopHelp({tool:name})" : "describeTool(name)"})),
  search: await searchTools("workflow task schedule", {limit: 3})
};`;
const READ_SCRIPT = `return { loops: await tools.LoopList({}), tasks: await tools.TaskList({}), monitors: await tools.MonitorList({}) };`;
const EMPTY_STATE = {
  loops: "No loops configured. Use LoopCreate to set up a schedule.",
  tasks: "No tasks.",
  monitors: "No monitors.",
};

function contentText(result: { content: Array<{ type: string; text?: string }> }) {
  return result.content.flatMap(part => part.type === "text" ? [part.text ?? ""] : []).join("\n");
}

function scriptData(result: Awaited<ReturnType<Awaited<ReturnType<typeof createNativeSession>>["script"]>>) {
  if (result.isError || !result.content[0] || result.content[0].type !== "text" || !result.content[0].text.startsWith("Script completed")) {
    throw new Error("Native profile script failed");
  }
  try {
    return JSON.parse(contentText({ content: result.content.slice(1) })) as Record<string, unknown>;
  } catch (cause) {
    throw new Error("Native profile script did not return complete JSON", { cause });
  }
}

export async function profileContextCase(spec: ContextCase) {
  let stage: ProfileStage = "initial";
  const captures: RequestCapture[] = [];
  const harness = await createNativeSession({
    ...spec,
    onRequest(context, workspace) {
      appendRequestCapture(captures, context, workspace, stage);
    },
  });
  async function measure() {
    const active = harness.session.getActiveToolNames();
    const callable = harness.session.getCallableToolNames();
    const registered = harness.session.getAllTools().map(tool => ({
      name: tool.name,
      exposure: tool.exposure,
      piLoop: isLoopTool(tool.name),
      active: active.includes(tool.name),
      callable: callable.includes(tool.name),
      description: textSize(tool.description),
      guidelines: textSize((tool.promptGuidelines ?? []).join("\n")),
      parameters: jsonSize(tool.parameters),
    }));
    await harness.prompt();
    stage = "repeat";
    await harness.prompt();

    let discovery = null;
    const enabled = active.includes("codemode");
    if (enabled) {
      stage = "discovery";
      const result = await harness.script(discoveryScript(spec.contextProfile === "compact"));
      const data = scriptData(result);
      if (!Array.isArray(data.controllers) || data.controllers.length !== 3 || data.controllers.some(value => typeof value !== "string")) {
        throw new Error("Controller discovery was incomplete");
      }
      if (!Array.isArray(data.names) || registered.filter(tool => tool.piLoop && tool.callable).some(tool => !(data.names as unknown[]).includes(tool.name))) {
        throw new Error("Discovery omitted a callable pi-loop tool");
      }
      discovery = { content: jsonSize(result.content), workload: spec.contextProfile === "compact"
        ? "3 original controller contracts via LoopHelp, search(limit=3), callable names"
        : "3 controller declarations, search(limit=3), callable names" };
    }

    stage = "read";
    let observed: Record<string, unknown>;
    let readResults: ReturnType<typeof jsonSize>;
    if (enabled) {
      const result = await harness.script(READ_SCRIPT);
      observed = scriptData(result);
      readResults = jsonSize(result.content);
    } else {
      const results = await harness.callMany(["LoopList", "TaskList", "MonitorList"].map(name => ({ name, args: {} })));
      if (results.some(result => result.isError)) throw new Error("Direct profile read failed");
      observed = Object.fromEntries(Object.keys(EMPTY_STATE).map((key, i) => {
        const result = results[i];
        if (!result) throw new Error("Missing direct read result");
        return [key, contentText(result)];
      }));
      readResults = jsonSize(results.map(result => result.content));
    }
    if (Object.entries(EMPTY_STATE).some(([key, value]) => observed[key] !== value)) throw new Error("Read-only profile did not observe empty stores");
    if (JSON.stringify(harness.session.getActiveToolNames()) !== JSON.stringify(active)) throw new Error("Profiling changed tool activation");
    const allowed = ["codemode", "LoopList", "TaskList", "MonitorList", ...(spec.contextProfile === "compact" ? ["LoopHelp"] : [])];
    if (harness.calls.some(name => !allowed.includes(name))) throw new Error("Unexpected tool executed during profiling");
    if (captures.length !== (enabled ? 6 : 4)) throw new Error("Unexpected native request count");

    const first = captures[0];
    if (!first) throw new Error("Missing initial request capture");
    const summary = {
      name: spec.name,
      fixture: spec,
      registered,
      active,
      callable,
      declared: first.metrics.tools.map(tool => tool.name),
      requests: captures.map(requestSummary),
      repeat: repeatedRequestSummary(captures),
      discovery,
      readResultContent: readResults,
      executedTools: harness.calls,
      emptyStateVerified: true,
      activationUnchanged: true,
    };
    return { summary, captures };
  }
  try {
    const result = await measure();
    await harness.close();
    return result;
  } catch (error) {
    try { await harness.close(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], "Profile and cleanup failed"); }
    throw error;
  }
}

export async function sourceIdentity(root: string, extraFiles: string[] = []) {
  const files: string[] = [];
  async function visit(dir: string) {
    for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
      const name = join(dir, entry.name);
      if (entry.isDirectory()) await visit(name);
      else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(name);
    }
  }
  await visit("src");
  files.push("package.json", "package-lock.json", "benchmarks/native-session.ts", "benchmarks/native-tool-observer.ts", "benchmarks/tool-context-report.ts", "benchmarks/profile-tool-context.ts", ...extraFiles);
  const hashes = [];
  for (const file of files.sort((a, b) => {
    if (a === b) return 0;
    return a < b ? -1 : 1;
  })) hashes.push({ path: file.replaceAll("\\", "/"), sha256: sha256(await readFile(join(root, file), "utf8")) });
  let head = null;
  try { head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", timeout: 3000, maxBuffer: 4096, stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { /* Source hashes remain available outside a Git checkout. */ }
  return { head, files: hashes, sha256: sha256(JSON.stringify(hashes)) };
}

async function writeReport(out: string, metadata: { complete: boolean }) {
  const temp = join(out, metadata.complete ? "complete-report.tmp" : "incomplete-report.tmp");
  await writeFile(temp, boundedJson(metadata), { flag: "wx", mode: 0o600 });
  await rename(temp, join(out, "report.json"));
}

export async function runToolContextProfile(args: string[], runCase = profileContextCase) {
  const options = contextOptions(args);
  if (options.help) {
    process.stdout.write("Usage: npm run profile:tools -- [--out DIRECTORY] [--context full|compact]\nFixed six-case native SDK matrix; no model inference or provider token/cache measurements.\n");
    return null;
  }
  const root = fileURLToPath(new URL("..", import.meta.url));
  const source = await sourceIdentity(root);
  await mkdir(options.out, { recursive: true });
  const out = await mkdtemp(join(options.out, "run-"));
  const cases: Awaited<ReturnType<typeof profileContextCase>>["summary"][] = [];
  const metadata = {
    schemaVersion: 1,
    contextProfile: options.contextProfile ?? "full",
    complete: false,
    startedAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    sdk: VERSION,
    piAi: PI_AI_VERSION,
    fixture: { nativeModelsApi: false, sdkDefaultTools: true, externalExtensions: false, operatorContext: false },
    source,
    boundary: "Native SDK streamSimple TranscriptContext before provider-specific HTTP serialization",
    units: "UTF-16 code units (chars); UTF-8 bytes; compact JSON for structured metrics",
    captureNormalization: "Only synthetic workspace strings replaced; metrics/hashes precede replacement",
    accounting: "Effective instructions, declarations, and transcript metrics overlap; do not add them",
    limitations: "Scripted fixture only. No model routing, provider token counts, wire payloads, latency or cache-reuse measurements. Disabled/inactive cases have no discovery stage; total traffic is not an equivalent-work savings comparison.",
    limits: { requestBytes: MAX_CAPTURE_BYTES, requestsPerCase: MAX_CASE_REQUESTS, bytesPerArtifact: MAX_ARTIFACT_BYTES },
    requestedCases: CONTEXT_CASES.map(spec => spec.name),
    cases,
    captures: [] as Array<{ name: string; file: string; bytes: number; sha256: string }>,
    failure: null as string | null,
  };
  try {
    for (const spec of CONTEXT_CASES) {
      const result = await runCase({ ...spec, ...(options.contextProfile === "compact" ? { contextProfile: "compact" as const } : {}) });
      const raw = boundedJson(result.captures);
      const file = `${spec.name}.requests.json`;
      await writeFile(join(out, file), raw, { flag: "wx", mode: 0o600 });
      metadata.captures.push({ name: spec.name, file, bytes: textSize(raw).bytes, sha256: sha256(raw) });
      cases.push(result.summary);
    }
    metadata.complete = true;
    await writeReport(out, metadata);
  } catch (error) {
    metadata.complete = false;
    metadata.failure = error instanceof Error ? error.name : "Unknown profile failure";
    try { await writeReport(out, metadata); }
    catch (reportError) { throw new AggregateError([error, reportError], "Profile and failure-report write failed"); }
    throw error;
  }
  process.stdout.write(`${JSON.stringify({ report: relative(process.cwd(), join(out, "report.json")), complete: true, cases: cases.length })}\n`);
  return { out, metadata };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runToolContextProfile(process.argv.slice(2));
}
