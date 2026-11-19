import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { build } from "esbuild";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDirectory = fileURLToPath(new URL("..", import.meta.url));
const temporaryDirectory = mkdtempSync(join(tmpdir(), "pi-loop-package-"));
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

async function assertFactoryReadiness(factory, api, external) {
  const previous = { loop: process.env.PI_LOOP, scope: process.env.PI_LOOP_SCOPE };
  process.env.PI_LOOP = "off";
  process.env.PI_LOOP_SCOPE = "memory";
  const bus = new EventEmitter();
  const hooks = new Map();
  const tools = new Map();
  const events = { emit: (name, data) => bus.emit(name, data), on: (name, handler) => { bus.on(name, handler); return () => bus.off(name, handler); } };
  if (external) events.on(api.TASKS_RPC.ping, request => queueMicrotask(() => events.emit(api.replyChannel(api.TASKS_RPC.ping, request.requestId), { success: true, data: { version: api.PROTOCOL_VERSION, provider: "package-control" } })));
  const pi = { events, on: (name, handler) => { hooks.set(name, [...(hooks.get(name) ?? []), handler]); }, registerTool: tool => tools.set(tool.name, tool), registerCommand() {}, sendMessage() {}, sendUserMessage() {} };
  const ctx = { cwd: temporaryDirectory, hasUI: false, isIdle: () => true, hasPendingMessages: () => false, sessionManager: { getSessionId: () => "package-control" }, ui: { setStatus() {}, setWidget() {}, notify() {} } };
  const dispatch = async name => { for (const handler of hooks.get(name) ?? []) await handler({}, ctx); };
  try {
    factory(pi);
    const ping = await api.rpcProbe(events, api.TASKS_RPC.ping, 1000);
    assert.equal(ping?.version, api.PROTOCOL_VERSION, "factory-time current-protocol task RPC remains discoverable");
    await new Promise(resolve => setImmediate(resolve));
    await dispatch("session_start");
    assert.equal(tools.has("TaskCreate"), !external, "provider selection determines initial native task tools");
    const prefix = [...tools.values()].map(tool => ({ name: tool.name, parameters: tool.parameters, description: tool.description, promptGuidelines: tool.promptGuidelines }));
    await dispatch("turn_start");
    assert.deepEqual([...tools.values()].map(tool => ({ name: tool.name, parameters: tool.parameters, description: tool.description, promptGuidelines: tool.promptGuidelines })), prefix, "first-turn schemas/guidelines do not change after session_start");
    for (const name of ["LoopCreate", "MonitorCreate", "WorkflowCreate", "WorkflowClaim", "WorkflowTransition"]) assert(tools.has(name), `${name} remains available`);
  } finally {
    await dispatch("session_shutdown");
    if (previous.loop === undefined) delete process.env.PI_LOOP; else process.env.PI_LOOP = previous.loop;
    if (previous.scope === undefined) delete process.env.PI_LOOP_SCOPE; else process.env.PI_LOOP_SCOPE = previous.scope;
  }
}

try {
  const rawReport = execFileSync(npmCommand, ["pack", "--json", "--ignore-scripts", "--pack-destination", temporaryDirectory], {
    cwd: rootDirectory,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  let packReport;
  try {
    packReport = JSON.parse(rawReport);
  } catch (error) {
    throw new Error("npm pack returned invalid JSON", { cause: error });
  }
  // npm <= 11 reports an array; npm 12 reports an object keyed by package name.
  const packageReport = Array.isArray(packReport) ? packReport[0] : Object.values(packReport ?? {})[0];
  assert(packageReport?.filename, "npm pack must report the packed tarball");
  const paths = (packageReport?.files ?? []).map((file) => file.path);

  assert(paths.includes("dist/index.js"), "tarball must include dist/index.js");
  assert(paths.includes("dist/index.d.ts"), "tarball must include dist/index.d.ts");
  assert(paths.includes("dist/api.js"), "tarball must include dist/api.js");
  assert(paths.includes("dist/api.d.ts"), "tarball must include dist/api.d.ts");
  assert(paths.includes("docs/RUNTIME_CONTINUITY.md"), "tarball must include the linked runtime continuity guide");
  assert(!paths.some((path) => path.startsWith("src/")), "tarball must not publish src/");

  const root = await import("@trevonistrevon/pi-loop");
  const api = await import("@trevonistrevon/pi-loop/api");
  assert.equal(typeof root.default, "function", "root export must be the Pi extension");
  assert.equal(typeof api.TaskStore, "function", "api export must expose TaskStore");

  const tarball = join(temporaryDirectory, packageReport.filename);
  execFileSync("tar", ["-xzf", tarball], { cwd: temporaryDirectory });
  symlinkSync(join(rootDirectory, "node_modules"), join(temporaryDirectory, "package", "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const packedRoot = await import(pathToFileURL(join(temporaryDirectory, "package", "dist", "index.js")).href);
  const packedApi = await import(pathToFileURL(join(temporaryDirectory, "package", "dist", "api.js")).href);
  assert.equal(typeof packedRoot.default, "function", "packed root must load as the Pi extension");
  assert.equal(typeof packedApi.TaskStore, "function", "packed api must load TaskStore");
  await assertFactoryReadiness(packedRoot.default, packedApi, false);
  await assertFactoryReadiness(packedRoot.default, packedApi, true);
  const graph = await build({ absWorkingDir: join(temporaryDirectory, "package"), entryPoints: ["dist/index.js"], bundle: true, platform: "node", format: "esm", packages: "external", metafile: true, write: false, logLevel: "silent" });
  assert(Object.keys(graph.metafile.inputs).length <= 5, "compiled entry must not restore the eager many-file internal graph");
  assert.equal(typeof packedApi.diagnoseWorkflowGraph, "function", "packed api must expose graph diagnostics");
  assert.deepEqual(packedApi.diagnoseWorkflowGraph({
    definition: { version: 1, initialState: "work", states: { work: { prompt: "Work" } } },
    currentState: "work", attemptsByState: { work: 1 },
  }), [{ code: "dead_end", states: ["work"] }]);

  const consumer = join(temporaryDirectory, "package", "legacy-consumer.mts");
  writeFileSync(consumer, `
import type { WorkflowRevisionFailure, WorkflowRevisionFailureCode } from "@trevonistrevon/pi-loop/api";
export const legacy: WorkflowRevisionFailureCode = "revision_limit_reached";
export function handlesLegacy(failure: WorkflowRevisionFailure): boolean {
  switch (failure.code) {
    case "revision_limit_reached": return true;
    default: return false;
  }
}
`);
  execFileSync(process.execPath, [
    join(rootDirectory, "node_modules", "typescript", "bin", "tsc"),
    "--ignoreConfig", "--noEmit", "--strict", "--skipLibCheck", "--target", "ES2022",
    "--module", "NodeNext", "--types", "node", consumer,
  ], { cwd: join(temporaryDirectory, "package"), encoding: "utf8", stdio: "pipe" });

  console.log(`package smoke passed (${paths.length} files; public types compiled)`);
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
