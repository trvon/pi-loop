# pi-loop reference

## Authority boundaries

pi-loop separates controller, standalone-task, worker-execution, and monitor authorities:

| Domain | Authority | Storage |
| --- | --- | --- |
| Loop controllers, workflow state, and orchestration intent, evidence, and local capacity | `LoopStore` | `.pi/loops/*.json` |
| Standalone native tasks | `TaskStore` or external `pi-tasks` | `.pi/tasks/*.json` or provider-owned |
| Orchestration worker execution and global concurrency | protocol-v2 `pi-subagents` | provider-owned |
| Running monitors | `MonitorManager` | process memory |

Workflow state work is embedded in `LoopStore` as `WorkflowExecutionRecord`. It never appears in TaskStore, `/tasks`, task RPC, `TaskClaim`, or `TaskUpdate`. Standalone tasks never control workflow transitions. Finite orchestration intent, dispatch reservations, local capacity, and evidence are embedded in LoopStore; they never discover or project tasks or workflow executions. `pi-subagents` owns worker execution and its global queue.

Notification buffers and monitor process handles are memory-only. Orchestration wake intent is durable until delivery acknowledgement, but delivery remains at-least-once across a crash. Persisted controllers recover when Pi resumes; they do not execute while Pi is absent.

## Runtime map

- `src/index.ts`: extension registration and top-level wiring
- `src/types.ts`: loop, workflow, orchestration, and monitor contracts
- `src/store.ts`: loop/workflow/orchestration persistence and atomic mutations
- `src/task-store.ts`: standalone native task persistence
- `src/*-reducer.ts`: pure state transitions
- `src/runtime/`: session, notification, backlog, task-provider, orchestration, and monitor-completion wiring
- `src/tools/`: model-facing tool registrations
- `src/rpc/`: vendored cross-extension RPC contract
- `src/ui/`: status widget and tool rendering

File-backed stores use PID locks, unique temporary snapshots, fsync, atomic rename, and previous-snapshot recovery. Corrupt state fails visibly when no valid snapshot exists.

## Scope

`PI_LOOP_SCOPE` selects storage ownership:

- `memory`: process-local and discarded;
- `session` (default): isolated by Pi session ID;
- `project`: shared in the working directory.

Project scope shares durable state but does not yet elect one scheduler owner across concurrent Pi runtimes. Workflow execution leases prevent duplicate phase work; they are separate from the planned project scheduler fence. Subagent orchestration rejects memory, project, disabled, and custom-path stores; it supports only default file-backed session scope.

## Loop model

`LoopEntry.status` is `active` or `paused`. New pauses persist optional provenance as `pause:{kind,at,reason?}`. Kinds distinguish `administrative`, `controller_limit`, `semantic_terminal`, and `orchestration_settlement`; older paused snapshots may remain unattributed. Resume clears the record. Triggers are:

- cron: `{type:"cron", schedule}`
- event: `{type:"event", source, filter?}`
- hybrid: `{type:"hybrid", cron, event, debounceMs}`
- dynamic: `{type:"dynamic"}`

`LoopCreate` creates ordinary controllers. Use dynamic loops for one evolving goal without named phase/outcome routing; use workflows for ordered phases, conditional outcomes, rework, or durable handoff; use standalone tasks for independently completable backlog items. `LoopUpdate` is only for dynamic controllers that are neither workflow nor orchestration owned and must persist `continue` after empty or unchanged iterations while work remains. `LoopDelete` pauses or removes ordinary/workflow controllers and cancellation-fences orchestration before stopping its workers. Recurring loops expire after seven days unless explicitly recreated; `LoopList` exposes the ISO `expiresAt` boundary, and retirement emits `loops:expired` plus a hidden notification with `deleted` or `paused` disposition. Fire limits bound repeated execution.

Wake delivery is idle-driven. A due timer or event mutates loop state, emits `loop:fire`, buffers a generation-tagged notification, and sends a hidden Pi message when delivery is safe. Expiry follows the same generation-fenced notification path after the retirement mutation and emits a typed `loops:expired` payload. Pending fire and expiry notifications are memory-only; they are not a durable event ledger across process death. Stale extension contexts are probed before fire mutation.

## Subagent orchestration model

`OrchestrationCreate` persists an explicit finite batch of independent work directly in one dynamic `LoopEntry`. It requires the default file-backed session scope and a protocol-v2 `pi-subagents` responder before writing state. It does not discover TaskStore records, execute workflow phases, or use the generic scheduler.

The parent `agent_end`, existing 30-second heartbeat, session recovery, and direct `subagents:started|completed|failed` events drive reconciliation. Before each spawn, LoopStore records a generated dispatch ID and consumes local capacity. Spawn forces background execution, disables inherited extension tools, and leaves global queue/concurrency authority with `pi-subagents`. `spawning`, `queued`, and `running` all count against the local limit.

Lifecycle callbacks CAS loop revision, owner runtime/generation, work ID, dispatch ID, attempt, and agent ID. Terminal evidence is bounded and persisted synchronously before `subagents:rpc:consume`. Proved failures retry only within `maxAttempts`; a spawn timeout is ambiguous without upstream status/list or idempotent dispatch keys, so it becomes `uncertain` and is never retried automatically.

Completion bursts refill capacity without waking the parent. A hidden parent wake is emitted only when the batch completes or needs attention. Its sequence remains durable until `pi.sendMessage` succeeds; a crash before acknowledgement may duplicate delivery. Completed/attention controllers pause for `OrchestrationGet` inspection and explicit deletion.

Session shutdown/switch invalidates lifecycle callbacks, best-effort stops known workers, and persists stopped work as retryable or unconfirmed work as uncertain before store rebinding. A new runtime cannot adopt an unexpired foreign owner lease; after expiry it marks active dispatches uncertain rather than risking duplicates. Project scope, dynamic work addition, dependency graphs, cross-session election, and exact-once dispatch are not implemented.

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

`WorkflowTransition` validates the current lease, declared available outcome, attempt limit, active execution, and definition revision. Ordinary transitions proceed directly. A transition into a `paused` terminal state additionally requires `claim:{class,provider,subject,fact,expected}`. A trusted provider observes the fact outside the LoopStore lock; admission rejects missing, unavailable, stale, expired, conflicting, contradicted, or cross-context observations without writing. The built-in `monitor` provider exposes only `status`, `exitCode`, and `stopReason`; monitor output is never evidence. Admission confirms the exact fact, not whether workflow policy should treat that fact as a blocker—the declared edge remains the workflow author's policy. No user-authority provider is built in, and machine providers cannot grant `user_authority`, so those claims fail closed. After confirmation, the existing state/revision/execution CAS protects the locked transition.

No pending claim or general evidence ledger is persisted. A confirmed transition stores only a bounded admission receipt on `lastTransition` (claim class/provider/subject/fact/expected value, provider versions, and decision time). After restart, callers inspect current state and explicitly resubmit; stale context is rejected. One locked transition write settles source work, records evidence and the receipt, advances state, and creates the destination execution. A missing or exhausted route is handled through `WorkflowRevise`, not a fabricated transition. Completed terminals delete the controller; paused terminals preserve it with `semantic_terminal` pause provenance and represent a declared blocker—not a progress notification.

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
- Rejected dynamic, workflow, and orchestration CAS operations are state-preserving.
- Workflow writes never span LoopStore and TaskStore.
- Server-held workflow leases expose no bearer token.
- Standalone task claims intentionally use bearer IDs because task RPC crosses extension boundaries.
- Session generation, owner leases, and stale-context checks prevent delayed callbacks from mutating replacement state.

## Cross-extension RPC

`src/rpc/` is canonical here and vendored verbatim into pi-orca. Any edit requires copying both files and bumping `VENDOR_REV` in both repositories.

RPC uses request/reply events with `requestId` and `<channel>:reply:<requestId>` envelopes. `PROTOCOL_VERSION` gates capability. The native task RPC server registers at extension initialization and disables itself when an external provider is active.

External consumers import only `@trevonistrevon/pi-loop/api`. Deep `src/` imports are unsupported.

## Limits and recovery gaps

- 25 active loops
- 25 running monitors
- 32 orchestration work items, 8 local workers, and 3 attempts per item
- 8,192 result characters and 2,048 error characters per orchestration dispatch
- seven-day recurring-loop lifetime
- five-minute default interval for self-paced mode
- 32 workflow definition revisions
- 65,536 bytes per workflow definition

Remaining durability work is tracked separately in tasks: durable wake outbox, project scheduler fencing, and recoverable monitor execution. Current recovery is resume-time reconciliation, not unattended continuity or exactly-once delivery.

## Security boundary

Report vulnerabilities through GitHub private vulnerability reporting, never a public issue containing exploit details or secrets. CI and releases audit all dependencies. Do not use `npm audit fix --force`; update Pi and Pi TUI pins together and validate the resulting API contract.
