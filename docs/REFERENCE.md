# pi-loop reference

## Authority boundaries

pi-loop has three independent authorities:

| Domain | Authority | Storage |
| --- | --- | --- |
| Loops and workflows | `LoopStore` | `.pi/loops/*.json` |
| Standalone native tasks | `TaskStore` or external `pi-tasks` | `.pi/tasks/*.json` or provider-owned |
| Running monitors | `MonitorManager` | process memory |

Workflow state work is embedded in `LoopStore` as `WorkflowExecutionRecord`. It never appears in TaskStore, `/tasks`, task RPC, `TaskClaim`, or `TaskUpdate`. Standalone tasks never control workflow transitions.

Pending wake notifications and monitor process handles are memory-only. Persisted controllers recover when Pi resumes; they do not execute while Pi is absent.

## Runtime map

- `src/index.ts`: extension registration and top-level wiring
- `src/types.ts`: loop, workflow, and monitor contracts
- `src/store.ts`: loop/workflow persistence and atomic mutations
- `src/task-store.ts`: standalone native task persistence
- `src/*-reducer.ts`: pure state transitions
- `src/runtime/`: session, notification, backlog, task-provider, and monitor completion wiring
- `src/tools/`: model-facing tool registrations
- `src/rpc/`: vendored cross-extension RPC contract
- `src/ui/`: status widget and tool rendering

File-backed stores use PID locks, unique temporary snapshots, fsync, atomic rename, and previous-snapshot recovery. Corrupt state fails visibly when no valid snapshot exists.

## Scope

`PI_LOOP_SCOPE` selects storage ownership:

- `memory`: process-local and discarded;
- `session` (default): isolated by Pi session ID;
- `project`: shared in the working directory.

Project scope shares durable state but does not yet elect one scheduler owner across concurrent Pi runtimes. Workflow execution leases prevent duplicate phase work; they are separate from the planned project scheduler fence.

## Loop model

`LoopEntry.status` is `active` or `paused`. Triggers are:

- cron: `{type:"cron", schedule}`
- event: `{type:"event", source, filter?}`
- hybrid: `{type:"hybrid", cron, event, debounceMs}`
- dynamic: `{type:"dynamic"}`

`LoopCreate` creates ordinary controllers. Use dynamic loops for one evolving goal without named phase/outcome routing; use workflows for ordered phases, conditional outcomes, rework, or durable handoff; use standalone tasks for independently completable backlog items. `LoopUpdate` is only for dynamic non-workflow loops and must persist `continue` after empty or unchanged iterations while work remains. `LoopDelete` pauses or removes controllers. Recurring loops expire after seven days unless recreated; fire limits bound repeated execution.

Wake delivery is idle-driven. A due timer or event mutates loop state, emits `loop:fire`, buffers a generation-tagged notification, and sends a hidden Pi message when delivery is safe. Stale extension contexts are probed before fire mutation.

## Workflow model

`WorkflowDefinition.version` is 1. A state contains:

- `prompt`
- optional embedded `task:{subject,description}`
- optional `on:{outcome:targetState}`
- optional `maxAttempts`
- optional state-local cron `loop`
- optional terminal status `completed` or `paused`

A run persists current state, transition sequence, attempts, state fire counts, active execution, execution history, monitor wait, last transition, definition revision, and immutable definition history.

### Ownership

The initial task execution is leased to the creating runtime. Every destination execution, including self-loop retries, starts unowned. `WorkflowClaim` claims unowned work, renews the same owner, or takes over an expired lease. Live foreign ownership fails closed.

`WorkflowTransition` validates the current lease, declared available outcome, attempt limit, active execution, and definition revision. One locked write settles source work, records evidence, advances state, and creates the destination execution. A missing or exhausted route is handled through `WorkflowRevise`, not a fabricated transition. Completed terminal states delete the controller; paused terminal states preserve it for inspection and represent a declared blocker or required user authority—not a progress notification.

### Adaptive revision

`WorkflowRevise` accepts exact `expectedRevision`, `expectedState`, and `expectedTransitionSeq` plus a reason and 1–64 typed changes:

- `add_state`
- `revise_state` for non-current state content
- `add_transition`
- `redirect_transition` with `expectedTo`

Revision is additive: no remove, rename, full replacement, or current-state content mutation. Added states must be reachable and rejoin prior or terminal work. Redirected routes must retain a path to their prior target.

Acceptance appends the prior definition, reason, actor, timestamp, and patch to immutable history, then increments `definitionRevision`. Current execution, lease, counters, and scheduler state remain unchanged. Persist actionable plan gaps, then continue through the revised transition and claim while work remains actionable; revision never creates standalone workflow tasks. Maximum definition size is 65,536 UTF-8 bytes and maximum revision count is 32.

Revision and transition race through the same LoopStore lock. Revision-first makes a stale transition fail its definition CAS; transition-first makes a stale revision fail state/sequence CAS.

## Standalone tasks

Native task statuses are `pending`, `in_progress`, `completed`, and `closed`. `TaskClaim` starts or resumes unfinished work and returns a renewable bearer claim ID. `TaskHeartbeat` renews it. Terminal update or deletion of live claimed work requires that ID. Expired claims may be taken over.

Standalone tasks are independently completable backlog items. Related work that advances one evolving goal through ordered phases, conditional outcomes, rework, or durable handoff belongs in a workflow instead. Task prerequisites are description conventions, not first-class graph fields. Backlog workers use `TaskGet` to follow them, and unfinished handoffs persist material progress and next action through `TaskUpdate`.

pi-loop probes external `pi-tasks` through protocol-v2 RPC. When unavailable, the native provider and tools are registered. `autoTask` creates one standalone task per ordinary loop fire. `taskBacklog` adopts existing unfinished tasks and must use a recurring `tasks:created` trigger.

## Monitors

`MonitorCreate` spawns a detached process group, buffers bounded output, emits rate-limited progress, and records terminal status in memory. Its `timeout` is a renewable inactivity threshold: stdout/stderr bytes, JSONL progress, and `MonitorUpdate` renew the deadline; total runtime alone never stops an active monitor. `MonitorStop` sends TERM then KILL fallback. `onDone` creates a one-shot completion wake; `workflowId` pauses a workflow state's cadence until terminal monitor outcome.

Monitor events:

- `monitor:started`
- `monitor:output`
- `monitor:finished`
- `monitor:done`
- `monitor:error`

Monitor recovery across Pi process death is not implemented.

## Mutation guarantees

- Store mutations hold one file lock and persist one reducer snapshot.
- Rejected dynamic, workflow transition, and workflow revision CAS operations are state-preserving.
- Workflow writes never span LoopStore and TaskStore.
- Server-held workflow leases expose no bearer token.
- Standalone task claims intentionally use bearer IDs because task RPC crosses extension boundaries.
- Session generation and stale-context checks prevent delayed callbacks from mutating replacement state.

## Cross-extension RPC

`src/rpc/` is canonical here and vendored verbatim into pi-orca. Any edit requires copying both files and bumping `VENDOR_REV` in both repositories.

RPC uses request/reply events with `requestId` and `<channel>:reply:<requestId>` envelopes. `PROTOCOL_VERSION` gates capability. The native task RPC server registers at extension initialization and disables itself when an external provider is active.

External consumers import only `@trevonistrevon/pi-loop/api`. Deep `src/` imports are unsupported.

## Limits and recovery gaps

- 25 active loops
- 25 running monitors
- seven-day recurring-loop lifetime
- five-minute default interval for self-paced mode
- 32 workflow definition revisions
- 65,536 bytes per workflow definition

Remaining durability work is tracked separately in tasks: durable wake outbox, project scheduler fencing, and recoverable monitor execution. Current recovery is resume-time reconciliation, not unattended continuity or exactly-once delivery.

## Security boundary

Report vulnerabilities through GitHub private vulnerability reporting, never a public issue containing exploit details or secrets. CI and releases audit all dependencies. Do not use `npm audit fix --force`; update Pi and Pi TUI pins together and validate the resulting API contract.
