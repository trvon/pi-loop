import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDirectory = fileURLToPath(new URL("..", import.meta.url));
const temporaryDirectory = mkdtempSync(join(tmpdir(), "pi-loop-package-"));
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

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
  const packageReport = packReport[0];
  const paths = (packageReport?.files ?? []).map((file) => file.path);

  assert(paths.includes("dist/index.js"), "tarball must include dist/index.js");
  assert(paths.includes("dist/index.d.ts"), "tarball must include dist/index.d.ts");
  assert(paths.includes("dist/api.js"), "tarball must include dist/api.js");
  assert(paths.includes("dist/api.d.ts"), "tarball must include dist/api.d.ts");
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
