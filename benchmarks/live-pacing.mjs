#!/usr/bin/env node
/**
 * Live pacing benchmark: fixed orchestration concurrency vs. the aimd window
 * against a real model server with a real bottleneck.
 *
 * Each run creates an isolated git fixture with small JS tasks. Every task has
 * a failing node:test file; workers must make it pass without editing it. The
 * per-item verifier (`git diff --quiet -- <test> && node --test <test>`) is the
 * ACK. The parent has no builtin tools, so it cannot do the work itself.
 *
 *   PI_LOOP_LIVE_MODEL=<provider/model> node benchmarks/live-pacing.mjs
 *   LIVE_PACING_CONFIGS=fixed:1,fixed:2,fixed:4,fixed:8,aimd LIVE_PACING_SEEDS=2 LIVE_PACING_TASKS=8
 *
 * Results land in .artifacts/live-pacing/. Wall time, tokens, and window traces
 * are measurements of this machine, model, and server configuration only.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const model = process.env.PI_LOOP_LIVE_MODEL;
const subagentsExtension = resolve(process.env.PI_LOOP_LIVE_SUBAGENTS_EXTENSION
  ?? join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "npm", "node_modules", "@tintinweb", "pi-subagents", "src", "index.ts"));
const configs = (process.env.LIVE_PACING_CONFIGS ?? "fixed:1,fixed:2,fixed:4,fixed:8,aimd").split(",").map((raw) => {
  const [pacing, concurrency] = raw.trim().split(":");
  return { label: raw.trim(), pacing, concurrency: concurrency ? Number(concurrency) : 8 };
});
const seeds = Number(process.env.LIVE_PACING_SEEDS ?? 2);
const taskCount = Number(process.env.LIVE_PACING_TASKS ?? 8);
const runTimeoutMs = Number(process.env.LIVE_PACING_RUN_TIMEOUT_MS ?? 45 * 60_000);
const maxTurns = Number(process.env.LIVE_PACING_MAX_TURNS ?? 12);
const artifactDir = resolve(process.env.LIVE_PACING_ARTIFACT_DIR ?? join(projectDir, ".artifacts", "live-pacing"));
const extensionPath = join(projectDir, "dist", "index.js");

if (!model) {
  console.log("SKIP: set PI_LOOP_LIVE_MODEL=<provider/model> to run the live pacing benchmark");
  process.exit(0);
}
if (!existsSync(subagentsExtension)) {
  console.log("SKIP: set PI_LOOP_LIVE_SUBAGENTS_EXTENSION to a protocol-v2 pi-subagents extension entrypoint");
  process.exit(0);
}
if (!existsSync(extensionPath)) {
  console.log("SKIP: run npm run build first");
  process.exit(0);
}

const TASKS = [
  ["fizzbuzz", "fizzbuzz(n) returns an array of strings for 1..n with Fizz/Buzz/FizzBuzz substitutions",
    `assert.deepEqual(fizzbuzz(5), ["1","2","Fizz","4","Buzz"]);\nassert.equal(fizzbuzz(15)[14], "FizzBuzz");\nassert.deepEqual(fizzbuzz(0), []);`],
  ["slugify", "slugify(s) lowercases, trims, replaces runs of non-alphanumerics with one hyphen, and strips leading/trailing hyphens",
    `assert.equal(slugify("  Hello, World! "), "hello-world");\nassert.equal(slugify("a--b__c"), "a-b-c");\nassert.equal(slugify("---"), "");`],
  ["romanToInt", "romanToInt(s) converts a valid Roman numeral string to an integer",
    `assert.equal(romanToInt("III"), 3);\nassert.equal(romanToInt("MCMXCIV"), 1994);\nassert.equal(romanToInt("XLIX"), 49);`],
  ["isBalanced", "isBalanced(s) returns true when (), [], {} are balanced and properly nested, ignoring other characters",
    `assert.equal(isBalanced("([]{})"), true);\nassert.equal(isBalanced("([)]"), false);\nassert.equal(isBalanced("a(b)c"), true);\nassert.equal(isBalanced("(("), false);`],
  ["rle", "rle(s) run-length encodes a string as count+char pairs",
    `assert.equal(rle("aaabcc"), "3a1b2c");\nassert.equal(rle(""), "");\nassert.equal(rle("z"), "1z");`],
  ["camelToSnake", "camelToSnake(s) converts camelCase or PascalCase to snake_case, keeping acronyms together",
    `assert.equal(camelToSnake("helloWorld"), "hello_world");\nassert.equal(camelToSnake("PascalCase"), "pascal_case");\nassert.equal(camelToSnake("parseHTTPRequest"), "parse_http_request");`],
  ["parseDuration", "parseDuration(s) parses strings like '1h30m', '45s', '2h5s' into total seconds",
    `assert.equal(parseDuration("1h30m"), 5400);\nassert.equal(parseDuration("45s"), 45);\nassert.equal(parseDuration("2h5s"), 7205);`],
  ["chunk", "chunk(arr, n) splits an array into arrays of length n (last may be shorter); n < 1 throws RangeError",
    `assert.deepEqual(chunk([1,2,3,4,5], 2), [[1,2],[3,4],[5]]);\nassert.deepEqual(chunk([], 3), []);\nassert.throws(() => chunk([1], 0), RangeError);`],
  ["flattenDeep", "flattenDeep(arr) flattens arbitrarily nested arrays",
    `assert.deepEqual(flattenDeep([1,[2,[3,[4]]],5]), [1,2,3,4,5]);\nassert.deepEqual(flattenDeep([]), []);`],
  ["isPrime", "isPrime(n) returns true for prime integers and false otherwise (including n < 2)",
    `assert.equal(isPrime(2), true);\nassert.equal(isPrime(97), true);\nassert.equal(isPrime(1), false);\nassert.equal(isPrime(91), false);`],
  ["lcsLength", "lcsLength(a, b) returns the length of the longest common subsequence of two strings",
    `assert.equal(lcsLength("abcde", "ace"), 3);\nassert.equal(lcsLength("abc", "def"), 0);\nassert.equal(lcsLength("", "a"), 0);`],
  ["wordFreq", "wordFreq(text) returns an object of lowercase word counts, splitting on non-letters",
    `assert.deepEqual(wordFreq("The cat. the HAT!"), { the: 2, cat: 1, hat: 1 });\nassert.deepEqual(wordFreq(""), {});`],
];

function shuffled(items, seed) {
  let a = seed >>> 0;
  const random = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function createFixture(tasks) {
  const dir = mkdtempSync(join(tmpdir(), "pi-loop-live-pacing-"));
  mkdirSync(join(dir, "src"));
  mkdirSync(join(dir, "test"));
  mkdirSync(join(dir, "sessions"));
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "pacing-fixture", private: true, type: "module" }, null, 2)}\n`);
  for (const [name, spec, assertions] of tasks) {
    writeFileSync(join(dir, "src", `${name}.js`), `// ${spec}\nexport function ${name}() {\n  throw new Error("not implemented");\n}\n`);
    writeFileSync(join(dir, "test", `${name}.test.js`), `import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { ${name} } from "../src/${name}.js";\n\ntest("${name}", () => {\n${assertions.split("\n").map((line) => `  ${line}`).join("\n")}\n});\n`);
  }
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("-c", "user.email=bench@example.invalid", "-c", "user.name=bench", "-c", "commit.gpgsign=false", "add", "-A");
  git("-c", "user.email=bench@example.invalid", "-c", "user.name=bench", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
  return dir;
}

function groundTruth(dir, tasks) {
  let passing = 0;
  for (const [name] of tasks) {
    try {
      execFileSync("git", ["diff", "--quiet", "--", `test/${name}.test.js`], { cwd: dir, stdio: "ignore" });
      execFileSync("node", ["--test", `test/${name}.test.js`], { cwd: dir, stdio: "ignore", timeout: 60_000 });
      passing += 1;
    } catch {
      // Failing or tampered test.
    }
  }
  return passing;
}

function readOrchestration(dir) {
  const loopDir = join(dir, ".pi", "loops");
  if (!existsSync(loopDir)) return undefined;
  for (const name of readdirSync(loopDir).filter((file) => file.endsWith(".json"))) {
    try {
      const loops = JSON.parse(readFileSync(join(loopDir, name), "utf8")).loops ?? [];
      const entry = loops.find((loop) => loop.orchestration);
      if (entry) return entry.orchestration;
    } catch {
      // Mid-write snapshot; the next poll reads the renamed file.
    }
  }
  return undefined;
}

async function runOnce(config, seed) {
  const tasks = shuffled(TASKS, seed).slice(0, taskCount);
  const dir = createFixture(tasks);
  const args = {
    goal: "Implement the fixture functions",
    work: tasks.map(([name, spec]) => ({
      prompt: `In the current repository, implement ${name} in src/${name}.js. Spec: ${spec}. Make \`node --test test/${name}.test.js\` pass. Do not modify anything under test/. Reply with one short sentence when done.`,
      verify: `git diff --quiet -- test/${name}.test.js && node --test test/${name}.test.js`,
    })),
    maxAttempts: 2,
    maxTurns,
    ...(config.pacing === "aimd" ? { pacing: "aimd" } : { concurrency: config.concurrency }),
  };
  const childEnv = { ...process.env, PI_LOOP_SCOPE: "session", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" };
  delete childEnv.PI_LOOP;
  const child = spawn("pi", [
    "--mode", "rpc", "--session-dir", join(dir, "sessions"), "--name", "pi-loop-live-pacing", "--approve",
    "--no-extensions", "--extension", extensionPath, "--extension", subagentsExtension,
    "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-builtin-tools", "--model", model,
  ], { cwd: dir, env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-12_000); });
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  const toolCalls = [];
  child.stdout.on("data", (chunk) => {
    buffer += decoder.write(chunk);
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try {
        const event = JSON.parse(line);
        if (event.type === "tool_execution_start") toolCalls.push(event.toolName);
      } catch {
        // Non-JSON diagnostics.
      }
    }
  });

  await new Promise((r) => setTimeout(r, 6500));
  const promptedAt = Date.now();
  child.stdin.write(`${JSON.stringify({ id: "create", type: "prompt", message: [
    "Call OrchestrationCreate exactly once with exactly these arguments, then stop:",
    JSON.stringify(args),
    "Do not call any other tool. When worker completion messages arrive later, reply with the single word ok and call no tools.",
  ].join("\n") })}\n`);

  const trace = [];
  let state;
  const deadline = promptedAt + runTimeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    state = readOrchestration(dir);
    if (!state) continue;
    const active = state.work.filter((item) => item.status === "active").length;
    trace.push({ t: Date.now() - promptedAt, active, cwnd: state.window?.cwnd, losses: state.window?.losses, taskLosses: state.window?.taskLosses });
    if (state.status !== "active" && active === 0) break;
  }
  child.kill("SIGTERM");
  await new Promise((r) => { const timer = setTimeout(() => { child.kill("SIGKILL"); r(); }, 5000); child.once("close", () => { clearTimeout(timer); r(); }); });

  const dispatches = state?.work.flatMap((item) => item.dispatches) ?? [];
  const settled = dispatches.map((d) => d.settledAt).filter(Number.isFinite);
  const result = {
    config: config.label,
    seed,
    model,
    tasks: tasks.map(([name]) => name),
    status: state?.status ?? "missing",
    timedOut: Date.now() >= deadline,
    wallMs: state && settled.length ? Math.max(...settled) - state.createdAt : undefined,
    verifiedItems: state?.work.filter((item) => item.status === "completed").length ?? 0,
    groundTruthPassing: groundTruth(dir, tasks),
    dispatches: dispatches.length,
    outputTokens: dispatches.reduce((sum, d) => sum + (d.usage?.tokens?.output ?? 0), 0),
    verifyFailures: dispatches.filter((d) => d.verify && !d.verify.passed).length,
    window: state?.window,
    parentToolCalls: toolCalls,
    perDispatch: dispatches.map((d) => ({ attempt: d.attempt, status: d.status, durationMs: d.usage?.durationMs, outputTokens: d.usage?.tokens?.output, verify: d.verify?.passed, error: d.error?.slice(0, 200), requestedAt: d.requestedAt - (state?.createdAt ?? 0), settledAt: (d.settledAt ?? 0) - (state?.createdAt ?? 0) })),
    trace,
    stderrTail: stderr.slice(-2000),
  };
  rmSync(dir, { recursive: true, force: true });
  return result;
}

mkdirSync(artifactDir, { recursive: true });
const results = [];
for (let seed = 1; seed <= seeds; seed++) {
  for (const config of configs) {
    process.stdout.write(`run ${config.label} seed=${seed} ... `);
    const result = await runOnce(config, seed);
    results.push(result);
    writeFileSync(join(artifactDir, `${config.label.replace(":", "-")}-seed${seed}.json`), `${JSON.stringify(result, null, 2)}\n`);
    console.log(`${result.status} wall=${result.wallMs === undefined ? "?" : (result.wallMs / 1000).toFixed(0)}s verified=${result.verifiedItems}/${taskCount} truth=${result.groundTruthPassing} dispatches=${result.dispatches} outTok=${result.outputTokens}`);
  }
}
writeFileSync(join(artifactDir, "summary.json"), `${JSON.stringify(results.map(({ trace, perDispatch, stderrTail, ...rest }) => rest), null, 2)}\n`);
console.log(`Artifacts: ${artifactDir}`);
