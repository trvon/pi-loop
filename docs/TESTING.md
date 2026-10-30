# Testing pi-loop

## Setup

```bash
git clone https://github.com/trvon/pi-loop.git
cd pi-loop
npm install
npm run hooks:install
```

Contributions use focused branches and signed, thematic commits. Open the first pull request against `master`; dependent pull requests target their predecessor branch. Run the local gate at every PR tip and relevant checks at each intermediate commit. Push normally with hooks; do not rewrite published stack history. Contributions are MIT licensed.

## Local gate

Run before opening or merging a code change:

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run test:package
npm audit --audit-level=moderate
git diff --check
```

Lint currently reports two established optional-chain warnings; new warnings are not accepted.

## Test layers

| Layer | Command | Purpose |
| --- | --- | --- |
| Unit/integration | `npm test` | Reducers, stores, runtimes, tools, session wiring |
| Coverage | `npm run test:coverage` | Enforced statement/branch/function/line thresholds |
| Property | `npm run test:property` | Generated state-machine invariants |
| Fuzz campaign | `npm run test:fuzz` | 10,000 generated cases |
| Package smoke | `npm run test:package` | Tarball contents and public imports |
| Live E2E | `npm run test:e2e` | Pi RPC/model conformance |
| Benchmarks | `npm run bench` | Fixed core workloads |
| CPU profile | `npm run profile:core` | V8 profile plus checksummed metadata |
| Startup profile | `npm run profile:startup` | Fresh-process CLI timing and separate CPU samples |
| Tool context | `npm run profile:tools` | Native SDK declarations, instructions, discovery and result sizes |
| Fuzz profile | `npm run profile:fuzz` | Allowlisted property-worker CPU capture and campaign evidence |

Unit tests use Vitest, fake timers for schedules, in-memory stores for pure behavior, temporary files for persistence/restart, and one shared Pi event-bus mock.

## Harness review campaigns

See [bounded review campaigns](./HARNESS_REVIEW_CAMPAIGNS.md) for the test-only
coverage/closure reference policy and traceable boundary inventory. Failed or
skipped mandatory discovery is incomplete, never a clean review. The inventory
checks references; the normal suite executes the underlying regressions.

## Native code mode

```bash
npx vitest run test/native-codemode.test.ts
```

The suite uses the pinned Pi SDK's session and native code-mode extension with a
scripted provider. It makes no remote model calls and reads no user credentials
or project context. Stores use memory; SDK files use isolated temporary directories.

Coverage includes absent/inactive code mode, `on` and `only` request declarations,
first-request native task availability, task claim/completion, zero-inline-budget
guideline discovery, inactive-tool exclusion, nested validation and permission
checks, and text business rejections. Each session emits shutdown and is disposed.

These tests establish SDK conformance, not model routing quality, provider cache
behavior, token savings, or compatibility with untested Pi versions. Tool exposure
remains `direct`; discovery does not activate tools.

## Workflow coverage

The workflow suites prove:

- creation and embedded initial execution;
- lease claim, renewal, expiry, and foreign-owner rejection;
- atomic settlement and unowned destination activation;
- retry attempts, evidence, terminal behavior, and cadence limits;
- typed add/revise/redirect definition patches;
- immutable revision history and current-execution preservation;
- revision/revision and revision/transition CAS races;
- legacy normalization and malformed-history rejection;
- revision-aware LoopList and wake guidance;
- no workflow-owned TaskStore records.

Primary files:

```text
test/workflow-reducer.test.ts
test/loop-reducer.test.ts
test/store.test.ts
test/loop-tools.test.ts
test/workflow-task-integration.test.ts
test/injection.test.ts
test/property/workflow.property.test.ts
```

## Subagent orchestration coverage

The orchestration suites prove finite-batch bounds, capacity reservation before spawn, reducer/store CAS immutability, lifecycle identity, early-start replay, bounded settlement before consume, retry/uncertainty policy, durable wake acknowledgement, session teardown, cancellation, scheduler exclusion, tool scope gating, compact presentation, and extension wiring.

Primary files:

```text
test/orchestration-reducer.test.ts
test/orchestration-store.test.ts
test/orchestration-runtime.test.ts
test/orchestration-tools.test.ts
test/property/orchestration.property.test.ts
```

Deterministic integration tests own timeout ambiguity and exact lifecycle ordering because upstream lacks status/list and idempotent dispatch keys. The opt-in live scenario additionally validates the supported protocol-v2 spawn, settlement, consume, and active-cancellation path against a real provider.

## Task-backlog coverage

A backlog wake must call `TaskList`, inspect `TaskGet`, claim or resume one task, perform work, run observable validation, and settle the task in the same turn. Tests reject status-only progress, missing claims, reasoning-only validation, and deferral to a later wake.

Description-declared prerequisites are followed through `TaskGet`; TaskStore has no dependency-edge field.

## Live E2E

Live tests are opt-in and run in isolated temporary workspaces. Stateful workflow and backlog scenarios use project scope; orchestration uses default file-backed session scope.

```bash
PI_LOOP_LIVE_MODEL="openai-codex/gpt-5.6-sol:minimal" npm run test:e2e
```

Workflow scenarios:

```bash
PI_LOOP_LIVE_SCENARIO=retry npm run test:e2e:workflow
PI_LOOP_LIVE_SCENARIO=phases npm run test:e2e:workflow
PI_LOOP_LIVE_SCENARIO=evolution npm run test:e2e:workflow
```

- `retry`: one embedded phase repeats once and completes.
- `phases`: at least three embedded phases advance with evidence.
- `evolution`: investigation calls `WorkflowRevise` with `add_state`, `redirect_transition`, and `revise_state`, then follows the revised path.

Every workflow scenario requires explicit phase claims, terminal completion, no standalone task/loop/monitor mutations, and an empty TaskStore.

Backlog scenario:

```bash
PI_LOOP_LIVE_MODEL="openai-codex/gpt-5.6-sol:minimal" npm run test:e2e:backlog
```

The backlog scenario requires this first-run sequence:

```text
TaskList → TaskGet → TaskClaim → write/edit → shell validation → TaskUpdate completed
```

Controller-routing scenarios:

```bash
PI_LOOP_LIVE_ROUTING_MODELS="openai-codex/gpt-5.6-sol:minimal,anthropic/claude-sonnet-4-6" \
npm run test:e2e:routing
```

Each model/scenario pair runs in a clean temporary Pi process with only `WorkflowCreate`, `TaskCreate`, and `LoopCreate` exposed. Natural-language prompts never name those tools. Critical success requires the exact controller type/count and successful tool validation; payload semantics and first-turn completion contribute to accuracy. Use `PI_LOOP_LIVE_ROUTING_SCENARIOS` for a comma-separated subset. See [controller routing evaluation](./CONTROLLER_ROUTING_EVAL.md) for the fixed baseline/hold-out matrix and judgment rules.

Subagent orchestration scenario:

```bash
PI_LOOP_LIVE_MODEL="openai-codex/gpt-5.6-sol:minimal" \
PI_LOOP_LIVE_SUBAGENTS_EXTENSION="$HOME/.pi/agent/npm/node_modules/@tintinweb/pi-subagents/src/index.ts" \
npm run test:e2e:orchestration
```

It runs in a temporary workspace with default file-backed session scope, proves two isolated workers settle with durable consumed evidence, then creates and cancels an active worker. The extension path defaults to the standard user package location when `PI_LOOP_LIVE_SUBAGENTS_EXTENSION` is omitted.

Without `PI_LOOP_LIVE_MODEL`, live scripts exit with `SKIP`. Reports are bounded JSON under `.artifacts/` and do not record credentials; claim IDs are redacted where applicable.

## Property and fuzz replay

The fixed-seed property suite covers cron boundaries, reducer determinism, workflow transition/revision immutability, orchestration CAS/bounds/uncertainty, attempt limits, and file-backed task replay.

Override campaign size:

```bash
FC_NUM_RUNS=50000 npm run test:property
```

Replay a minimized failure with both values printed by fast-check:

```bash
FC_SEED=24301 FC_PATH='0:0' npm run test:property
```

Keep the generalized property and add the minimized example to the nearest ordinary test before fixing production code.

## Benchmarks and profiles

```bash
npm run bench
npm run bench:baseline
npm run bench:compare
npm run profile:core
```

Core workloads live in `benchmarks/workloads.ts`. `bench:baseline` writes `.artifacts/benchmarks/baseline.json`; `bench:compare` reports throughput changes. Load `.cpuprofile` files in a V8-compatible viewer. Compare only the same machine, Node version, architecture, timezone, and power state.

### Tool context

```bash
npm run profile:tools
npm run profile:tools -- --out .artifacts/profiles/tool-context
npx vitest run test/native-codemode.test.ts test/tool-context-profile.test.ts
```

The fixed matrix runs code mode absent, registered but inactive, and `on`/`only`
with Pi's estimated-token inline budgets of 3,000 and zero. Each isolated SDK session sends an initial
request, a repeated request, and read-only list calls. Active code-mode cases also
request three controller declarations, a three-hit search, and callable tool names.
The provider is scripted. Native model helpers and external extensions are disabled;
no remote model or operator configuration is used.

Each unique run directory contains `report.json` and six request capture files.
The report records source hashes, SDK versions, registered/active/callable/declared
tools, per-tool schema/description sizes, effective instructions, transcript sizes,
and discovery/result traffic. Counts use UTF-16 code units and UTF-8 bytes before
synthetic workspace paths are replaced in saved captures. JSON metrics include
serialization overhead. Instructions, declarations and transcript metrics overlap;
do not sum them. Capture-file checksums cover the saved, normalized files.

Limits: 12 requests per case, 2 MiB per original request, 16 MiB per artifact.
Exceeding a limit fails without truncation. Case failures retain an incomplete
report and completed-case artifacts. Temporary SDK workspaces are removed.

This is the native SDK provider boundary, not a provider's HTTP payload. Token
counts and cache reuse remain `null`; fixture usage zeros are not measurements.
Disabled cases have no discovery stage, so total traffic is not an equivalent-work
savings comparison. Read-only profiling does not change exposure or activate tools.

### Context budgets

```bash
npx vitest run test/tool-copy-budget.test.ts test/tool-context-profile.test.ts
```

`test/fixtures/tool-context-budget.json` fixes per-tool and aggregate UTF-8 ceilings
for descriptions, input-schema JSON, schema-description text and declaration JSON.
Per-tool ceilings add 10%, rounded up to 32 bytes; aggregate ceilings round up to
100 bytes. Review fixture changes explicitly; tests never rebaseline themselves.
The older combined description/guideline character budget remains independent.
Schema-description text walks schema-bearing keywords, not enum/example/default
instance data or referenced documents. Fields overlap; do not sum them or call them
tokens. Mutation controls check schema-only inflation and Unicode parameter copy.

### Startup

Keep the prior compiled `dist` tree for comparison. Both builds must resolve the same host dependencies.

```bash
npm run profile:startup -- --baseline /path/to/prior/dist/index.js --candidate dist/index.js --profiles
```

The default is 15 measured rounds after 3 warmups, serial fresh processes, alternating case order. `--rounds` accepts 3–100; `--warmups` accepts 0–10. `--cli` selects a compiled Pi CLI. `--out` selects the artifact root; default `.artifacts/profiles/startup`. Each run owns a unique directory.

`report.json` retains raw wall time, physical child status, CPU/RSS, versions, static graph hashes, paired medians and a seeded bootstrap interval. Owned wrappers require affirmative factory-return receipts. CPU-profile children run separately; their timings do not enter comparisons. Profiles are capped at 64 MiB before write. Static graphs are not observed runtime-loading traces. CLI `--list-models` is not TUI first render or first-request latency. Do not run timing comparisons alongside fuzz campaigns or gates.

### Fuzz workers

```bash
npm run profile:fuzz -- --suite monitor-runtime --runs 100 --seed 130363
npm run profile:fuzz -- --suite monitor-runtime --runs 100 --seed 130363 \
  --test fault-injected --path '0'
```

Suites: `monitor-runtime`, `monitor-inactivity`, `monitor-native`, `workflow-restart`. Runs and seeds are positive safe integers. The runner caps cases at 1,000; native cases retain their existing cap of 64. Replay requires an explicit seed and a pattern selecting exactly one property, with no control tests. Each invocation runs one serial Vitest child without a shell or retries.

Artifacts default to `.artifacts/profiles/fuzz/<suite>-<unique>/`. `--out` changes the root. `--timeout-ms` defaults to and cannot exceed 600,000. Retained output is capped at 1 MiB per stream; hashes also cover observed discarded bytes. Worker profiles are capped at 64 MiB before write.

`summary.json` links raw campaign/reporter files and checksums. It distinguishes requested, capped, and observed counts. Unreported counters remain `null`. Failed, interrupted, skipped, missing-profile and missing-source-identity runs do not pass. Primary assertion logs survive reporting failures. Profiling is opt-in through `PI_LOOP_FUZZ_PROFILE_DIR`, set by the runner; normal tests do not start an inspector. Capture covers suite hooks in the actual property worker, not startup, the coordinator, or native descendants. Worker RSS is a process-lifetime high-water mark. Native POSIX skips are not Windows passes. Timing and profiles do not certify correctness.

## Change evidence

Follow `AGENTS.md` for the testing contract:

- Bug: behavioral regression fails on unchanged code, nearby control passes, same regression passes after repair.
- Feature: acceptance expectations precede implementation; test the affected surface and applicable boundaries.
- Invariant: independently test authority, ownership, rejection, lifecycle, bounds, and persistence properties that must remain unchanged.
- Model-facing guidance: validate examples and misuse deterministically; report bounded live model/fixture/attempt evidence separately. A text match is not a model-behavior result.

Name the expectations and invariants in the PR body. Record exact red/green commands and limitations. Compilation, fixture, or provider failures do not establish a product defect; skipped live checks do not pass.

## Change-specific minimums

- Reducer/store mutation: focused reducer + persistence/restart + property tests.
- Tool schema/copy: tool tests + `test/tool-copy-budget.test.ts`.
- Session/wake lifecycle: session, notification, scheduler, and index integration tests.
- Monitor behavior: manager, tool, onDone runtime, and package smoke tests.
- RPC contract: copy vendored files to pi-orca, bump `VENDOR_REV`, and run both repositories' RPC suites.
- Published surface: build, package smoke, and isolated tarball import.
