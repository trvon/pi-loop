# pi-loop development guide

## Purpose

pi-loop is a Pi extension for scheduled/event-driven re-wakes, self-paced goals, task-driven workflows, bounded subagent orchestration, native fallback tasks, and background process monitoring.

Stack: strict TypeScript 7, ES2022, TypeBox, Vitest, and Biome.

## Authority boundaries

Do not blur these domains:

- `LoopStore` exclusively owns loops, workflow definitions/revisions/executions/history/leases, and finite subagent orchestration batches/dispatches.
- `TaskStore` or external `pi-tasks` owns standalone tasks only.
- `/tasks`, task RPC, `TaskClaim`, and `TaskUpdate` never control workflow work.
- `MonitorManager` owns process-local monitor state; monitor recovery across Pi death is not implemented.
- `pi-subagents` owns worker execution and global concurrency. pi-loop owns only session-scoped orchestration intent, bounded evidence, local capacity, and recovery decisions.
- Pending notifications are memory-only; persisted controllers recover on resume, not while Pi is absent.

A feature that requires a cross-store workflow/task transaction violates the architecture.

## Source map

```text
src/index.ts                 extension registration and runtime wiring
src/api.ts                   supported @trevonistrevon/pi-loop/api surface
src/types.ts                 loop, workflow, revision, monitor contracts
src/store.ts                 LoopStore workflow/orchestration atomic mutations
src/task-store.ts            standalone native task persistence
src/*-reducer.ts             pure state transitions
src/coordinator.ts           reducer/effect coordination
src/scheduler.ts             cron scheduling and fire times
src/trigger-system.ts        cron/event/hybrid activation
src/monitor-manager.ts       child processes and bounded output
src/runtime/                 session, notification, backlog, orchestration, task-provider, monitor wiring
src/tools/                   model-facing tool definitions
src/commands/                /loop and /tasks
src/rpc/                     vendored cross-extension RPC
src/ui/                      status and tool rendering
test/                        unit, integration, property, and live harnesses
```

## Workflow contract

A workflow is one dynamic `LoopEntry` with a version-1 named-state definition.

- State `task` data materializes as `WorkflowExecutionRecord` in LoopStore.
- The creator owns the initial execution lease.
- Every destination/retry execution starts unowned and requires `WorkflowClaim`.
- `WorkflowTransition` validates the live owner, settles source work, records evidence, advances state, and creates destination work in one locked write.
- `WorkflowRevise` applies typed additive changes with definition/state/sequence CAS, immutable prior-definition history, and no scheduler or TaskStore effect.
- Current materialized state content is immutable. Current outgoing edges and future state content may be revised.
- Transition CAS includes definition revision so transition/revision races fail closed in either order.
- Terminal completed workflows are deleted; terminal paused workflows remain inspectable.

## Subagent orchestration contract

A first-generation orchestration is one finite, session-file-backed `LoopEntry` batch.

- It accepts explicit independent work only; it never discovers TaskStore work or workflow executions.
- Creation requires protocol-v2 `pi-subagents` and rejects memory/project/custom/off storage.
- Every dispatch is persisted before spawn and fenced by controller revision, owner runtime/generation, work ID, dispatch ID, attempt, and upstream agent ID.
- `spawning`, `queued`, and `running` consume local capacity; pi-subagents retains its global queue.
- Lifecycle evidence is bounded and persisted before `subagents:rpc:consume`.
- Proved failures may retry within the item budget. Ambiguous timeout/recovery never retries automatically.
- The existing session heartbeat reconciles orchestration; do not add another timer or scheduler.
- Session teardown invalidates callbacks before best-effort stop and state reconciliation.
- Project scope, dependency graphs, dynamic work addition, and exactly-once dispatch remain unsupported.

See `docs/REFERENCE.md` for the public contract.

## Persistence and lifecycle

Reducer-backed stores use:

- `O_EXCL` PID locks with stale-owner detection;
- unique temporary snapshots;
- file fsync, atomic rename, and directory fsync;
- previous-snapshot recovery;
- visible corruption failure when recovery is impossible.

`PI_LOOP_SCOPE` is `memory`, `session` (default), or `project`. Session shutdown/switch increments generation, stops triggers, clears pending wakes, stops owned orchestration workers, and reaps monitors before rebinding. Delayed callbacks must fail closed after generation/context changes.

Project scope does not yet elect one scheduler owner. Do not confuse planned scheduler fencing with workflow execution leases.

## Wake and monitor rules

All wakes deliver when the agent is idle. Do not enqueue uncancelable follow-up user messages early; buffer an in-memory notification, recheck generation/relevance, then call `pi.sendMessage`.

A stale extension context must be detected before loop mutation. Never swallow a stale emit after consuming fire state.

Monitor output is untrusted and exposed through bounded/rate-limited events. `onDone` and workflow monitor waits use direct completion callbacks plus generation/context checks. Session teardown must drain monitor shutdown before store rebinding.

## Standalone tasks and providers

pi-loop probes protocol-v2 `pi-tasks` and otherwise enables its native provider. Native task RPC registers at extension initialization so early peers cannot race fallback setup.

Task claims use bearer IDs because they cross extension boundaries. Workflow leases do not expose tokens. Task prerequisites are description conventions, not TaskStore graph fields.

`taskBacklog` adopts existing tasks and requires a recurring `tasks:created` event trigger. `autoTask` creates one task per ordinary loop fire; do not combine it with backlog mode.

## Vendored RPC

`src/rpc/channels.ts` and `src/rpc/cross-extension-rpc.ts` are canonical here and copied verbatim into pi-orca. Any change requires:

1. update both repositories;
2. bump `VENDOR_REV` in both copies;
3. run both RPC suites;
4. verify the files are byte-identical.

RPC uses request IDs and `<channel>:reply:<requestId>` success/error envelopes. External consumers import only `@trevonistrevon/pi-loop/api`; deep `src/` imports are unsupported.

## Coding conventions

- Comments explain why, never restate what.
- Use `debug(...)` behind `PI_LOOP_DEBUG`.
- Use `textResult(...)` for tool output.
- Tool parameters use exact TypeBox field names; do not add aliases.
- Recover obvious schema-call mistakes silently.
- Tool descriptions must state ownership and recovery boundaries without exceeding `test/tool-copy-budget.test.ts`.
- Model guidance must choose one controller: workflows for ordered phase/outcome/rework/handoff flows, standalone tasks for independently completable backlogs, and dynamic loops for self-paced goals without phase routing.
- A progress notification is not a terminal pause. Persist unfinished standalone or dynamic-loop progress with `TaskUpdate` or `LoopUpdate`; persist workflow plan changes or completed phases with `WorkflowRevise` or `WorkflowTransition`, then continue while work remains actionable.
- Mutations go through reducers/stores; do not directly edit persisted maps from tools/runtimes.
- Rejections are state-preserving and include a specific next action.
- Use red → green regressions for bugs and state-machine changes.
- Keep tests deterministic and file-backed tests isolated under `tmpdir`.

## Validation

Follow `docs/TESTING.md`. Minimum merge gate:

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run test:package
npm audit --audit-level=moderate
git diff --check
```

Lint has four established optional-chain warnings; do not add new warnings. Workflow/reducer changes also require property tests and the relevant live scenario.

## Limits

- 25 active loops
- 25 running monitors
- 32 orchestration work items
- 8 local orchestration workers
- 3 orchestration attempts per item
- seven-day recurring-loop lifetime
- five-minute self-paced default interval
- 32 workflow definition revisions
- 65,536 bytes per workflow definition
