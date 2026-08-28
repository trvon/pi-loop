# Testing pi-loop

## Setup

```bash
git clone https://github.com/trvon/pi-loop.git
cd pi-loop
npm install
npm run hooks:install
```

Contributions use focused branches and signed, thematic commits. Open pull requests against `master` after the local gate passes. Contributions are MIT licensed.

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

Lint currently reports four established optional-chain warnings; new warnings are not accepted.

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

Unit tests use Vitest, fake timers for schedules, in-memory stores for pure behavior, temporary files for persistence/restart, and one shared Pi event-bus mock.

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
npm run bench:baseline
npm run bench:compare
npm run profile:core
```

Compare benchmarks only on the same machine, Node version, architecture, timezone, and power state. Profiles are written to `.artifacts/profiles/`; load the `.cpuprofile` in a V8-compatible viewer. Shared benchmark workloads live in `benchmarks/workloads.ts`.

## Change-specific minimums

- Reducer/store mutation: focused reducer + persistence/restart + property tests.
- Tool schema/copy: tool tests + `test/tool-copy-budget.test.ts`.
- Session/wake lifecycle: session, notification, scheduler, and index integration tests.
- Monitor behavior: manager, tool, onDone runtime, and package smoke tests.
- RPC contract: copy vendored files to pi-orca, bump `VENDOR_REV`, and run both repositories' RPC suites.
- Published surface: build, package smoke, and isolated tarball import.
