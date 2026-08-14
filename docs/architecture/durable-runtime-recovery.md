# Durable Runtime Recovery

## Goal

Preserve actionable loop, workflow, task, monitor, and wake state when a Pi process exits or a session is resumed, without replaying canceled work, losing accepted work, or allowing two sessions to own the same project-scoped runtime.

Exactly-once delivery is not possible while `pi.sendMessage()` has no durable receipt or idempotency parameter. The implementable contract is at-least-once reservation with one actionable wake per stable ID, transcript-assisted deduplication, cancellation filtering, and fenced ownership.

## Recovery versus unattended continuity

Persistence alone cannot fire a timer or run a monitor after the Pi process exits. Two explicit operating modes are required:

1. **Recover-on-resume:** the extension stores state, records missed schedules, and reconciles work when an operator resumes the same session or adopts its state into another session. Nothing executes while Pi is absent.
2. **Supervised continuity:** an opt-in out-of-process `pi-loop` supervisor owns timers and monitor runners. It records pending wakes while no Pi session is attached. Automatic Pi launch/resume is a separate authority-bearing option; without it, the supervisor waits for the next attachment and then delivers.

Session death and process death are different. A closed session can leave a live Pi process, while a killed Pi process leaves no extension runtime. Documentation and tools must state which guarantee applies. Project-scoped continuity requires the supervisor or one live fenced Pi runtime; session snapshots alone provide recovery, not continuous execution.

## Current durability

| Entity | Current storage | Process-death behavior |
|---|---|---|
| Session loops and workflows | `.pi/loops/loops-<sessionId>.json` | Survive and re-arm when the same Pi session resumes. |
| Project loops and workflows | `.pi/loops/loops.json` | Survive, but multiple Pi processes can schedule the same loop. |
| Native tasks | `.pi/tasks/tasks-<sessionId>.json` or `tasks.json` | Survive, but `in_progress` has no owner, lease, or recovery rule. |
| Pending wakes | Memory only | Lost on process death; already-sent Pi messages cannot be retracted. |
| Monitors | Memory-only `ChildProcess` map | Handles, output, result, timeout, and `onDone` delivery are lost. Descendants may outlive the shell. |
| Deletion tombstones | Loop-store memory/snapshot lifecycle | Not sufficient to cancel a message already accepted by Pi. |

Workflow snapshots include state-local loop fire counts. On recovery, the scheduler re-arms only the current nonterminal state's cron policy, retaining its linked task and local cap; inactive-state policies never fire until `WorkflowTransition` enters their state.

## Audit findings

### 1. Fire and delivery are not one recoverable operation

`src/index.ts` persists `fireCount` before emitting `loop:fire`. `src/runtime/notification-runtime.ts` stores the resulting notification only in memory. A crash between those steps records a fire but loses its wake. A crash after `sendMessage()` but before local bookkeeping can replay the same work.

`src/trigger-system.ts` deletes event one-shots after firing. `src/scheduler.ts` removes cron one-shots only from its in-memory timer map, so restart can re-arm the stored loop.

### 2. Backlog liveness conflates pending and active work

`TaskStore.pendingCount()` counts both `pending` and `in_progress`. Historical worker prompts selected only `pending` tasks and treated any `in_progress` prerequisite as unavailable. This leaves the worker loop active while the model repeatedly reports no eligible pending work.

Persisted worker prompts were recognized as legacy workers but not upgraded. Startup must migrate their prompt before trigger registration.

Prompt recovery is necessary but not sufficient: an `in_progress` task still needs durable claim ownership and expiry before another runtime can safely resume it.

### 3. Monitor supervision is process-local

`MonitorManager` spawns `sh -c` with piped output and stores all state in memory. Stop signals the shell PID rather than a verified process group. `onDone` is a callback registered against that in-memory manager. Parent death can therefore lose completion, leak descendants, or leave a persisted `onDone` loop with no monitor to resolve it.

### 4. Store corruption fails open

`ReducerBackedStore.load()` ignores parse errors and leaves an empty in-memory store. Saves use a fixed temporary path and rename without file or directory `fsync`. Store envelopes have no schema version or checksum.

### 5. Scope ownership is incomplete

Session scope has a stable owner—the Pi session ID—but orphan files have no lifecycle metadata. Project scope has shared files with no runtime lease or fencing epoch, so concurrent Pi processes can both schedule and deliver.

Pi 0.83 uses `session_shutdown` followed by a new `session_start`; state rebinding and cleanup must not depend only on the legacy `session_switch` event.

## Target contracts

### Scope context

Create one immutable `ScopeContext` during `session_start`:

```ts
interface ScopeContext {
  scopeId: string;
  scope: "memory" | "session" | "project";
  sessionId?: string;
  runtimeId: string;
  fencingEpoch?: number;
}
```

The context owns stores, scheduler, trigger subscriptions, wake dispatcher, and monitor adapter. Delayed callbacks must carry this context and fail closed when its epoch is stale.

- **Memory:** no recovery.
- **Session:** only the matching resumed session can deliver its state.
- **Project:** one renewable lease owns scheduling and delivery; takeover increments a fencing epoch.

### Durable wakes

Store wake reservations inside the loop snapshot so loop mutation and reservation share one atomic write.

```ts
interface WakeRecord {
  wakeId: string;       // <scope>/<loopId>/fire/<fireSeq>
  loopId: string;
  fireSeq: number;
  state: "pending" | "leased" | "dispatched" | "consumed" | "canceled";
  payload: LoopFireEvent;
  createdAt: number;
  leaseOwner?: string;
  leaseExpiresAt?: number;
  coalesceKey?: string;
}
```

Startup scans the Pi branch for custom messages carrying `wakeId`, reconciles accepted records, cancels records whose loop tombstone wins, dispatches remaining records, then arms future schedules.

Recurring downtime uses an explicit misfire policy; default is coalesce-to-one. A one-shot becomes terminal only after wake reservation. Duplicate transcript messages are filtered by `wakeId` in the Pi context hook.

### Task claims

Add revisioned execution metadata:

```ts
interface TaskClaim {
  claimId: string;
  ownerSessionId: string;
  ownerRuntimeId: string;
  claimedAt: number;
  heartbeatAt: number;
  leaseExpiresAt: number;
  attempt: number;
}
```

Rules:

- Claim is compare-and-set against task revision.
- A live claim prevents duplicate execution.
- An expired claim is resumable by a new runtime and records takeover evidence.
- Workers resume owned `in_progress` work before claiming pending work.
- Starting a completed/closed task is rejected; reopening is an explicit operation and records `reopenedAt`.
- Dependency traversal selects the earliest unfinished prerequisite rather than waiting behind it forever.
- External task providers need RPC operation IDs, expected revisions, and claim capability. Protocol-v2 providers fall back to prompt recovery with a visible reduced-safety warning.

### Monitor runner

Move recoverable execution into a shipped runner process that owns a process group and writes:

- exclusive run receipt and token;
- PID/process-group identity;
- heartbeat and absolute deadline;
- capped/rotated stdout and stderr files;
- atomic terminal result.

On startup, Pi reattaches to a verified live runner or marks the monitor interrupted. Stop verifies the run token and kills the process group. `onDone` uses a stable completion wake ID and survives extension restart.

## Store format and recovery

Keep small JSON snapshots; SQLite does not solve Pi queue, external RPC, or child-process atomicity and adds packaging cost.

Use:

1. versioned envelope with checksum;
2. `current` and `previous` snapshots;
3. unique temporary file;
4. temp-file `fsync`, rename, then directory `fsync`;
5. validation before replacing current;
6. quarantine and visible recovery error instead of silently starting empty.

A pure append-only journal is not needed initially. Add a compact WAL only if mutation volume or cross-entity transaction requirements exceed the extended loop snapshot.

## Startup recovery order

1. Resolve `ScopeContext` and acquire lease/fence.
2. Load and validate current/previous snapshots.
3. Scan Pi transcript for accepted wake IDs.
4. Reconcile monitor runner receipts and results.
5. Reconcile workflow active-task links and task claims.
6. Reserve overdue/coalesced wakes.
7. Dispatch durable pending wakes.
8. Arm future schedules and event triggers.

## Migration and garbage collection

- Back up legacy files before migration.
- Add `reopenedAt`; legacy `in_progress` entries with `completedAt` require explicit reconciliation unless evidence proves a stale reopen.
- Legacy fired cron one-shots become terminal recovery records, not newly armed loops.
- Orphan `onDone` loops become canceled with an audit reason.
- Remove empty session files only after the corresponding Pi session file is absent beyond a grace period.
- Retain terminal monitor logs, consumed wakes, and tombstones for a bounded configurable period.
- Provide dry-run `state audit` and explicit `state reconcile` commands; never silently delete ambiguous work.

## Red-test-first implementation phases

1. **Backlog liveness:** current prompt migration, `in_progress` resume guidance, dependency-chain recovery, and no-empty-report contract.
2. **Task claims:** transition guards, revisions, lease ownership, expiry/takeover, and legacy reconciliation.
3. **Wake outbox:** atomic fire reservation, one-shot cron correctness, cancellation, transcript dedupe, dynamic-loop recovery, and misfire policy.
4. **Scope ownership and stores:** project lease/fencing, Pi 0.83 lifecycle rebinding, checksummed current/previous snapshots, corruption tests, and session GC.
5. **Monitor runner:** parent-death recovery, process-tree stop, timeout, output/result persistence, duplicate completion suppression, and `onDone` recovery.

Each phase must include kill-point fault injection at every persistence/external-effect boundary before production code changes.
