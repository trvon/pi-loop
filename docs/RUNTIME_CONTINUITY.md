# Runtime continuity

pi-loop runs inside an active Pi process. Persisted controller intent does not execute while Pi is absent. Resume-time reconciliation is not unattended continuity or exactly-once delivery.

## State and delivery matrix

Storage means the resolved store, not just `PI_LOOP_SCOPE`. `PI_LOOP` file overrides take precedence; `PI_LOOP=off`, memory scope, and an unbound session resolve to process-local controller storage. Native/external task persistence follows its task provider, not this LoopStore matrix.

| Resource | Retention | Resume or inspection boundary |
| --- | --- | --- |
| Memory/off/unbound-session controllers | Process-local | Do not assume state survives process loss or a new session. |
| Default session-file controllers | Isolated by Pi session ID | Resume the same session/store; a different session selects different state. |
| Project/custom-file controllers | Persisted in the resolved file | Shared state is not shared scheduler ownership; no scheduler owner election is implemented. |
| Cron controller intent | File-backed when configured | An active runtime must arm/pump scheduling. Do not assume missed intervals are replayed. |
| Ordinary pending fire/retirement notifications | memory-only | Clearing/switching the runtime discards the buffer, not committed fire accounting. No ordinary wake ledger or outbox. |
| Dynamic progress | Persisted when file-backed | Resume may issue a fresh activation from current state; it does not reconstruct the old buffered message or prove prior work did not run. |
| Event/hybrid subscriptions | Runtime registrations | Session recovery retires stale subscriptions. Recreate explicitly only when still required. |
| Workflow executions/leases | LoopStore records | Inspect current revision/state/execution; claim unowned or expired work. A live foreign lease is not bypassed and is not proof of execution. |
| Orchestration attention wake intent | Persisted until valid acknowledgement, unless cancelled or retired by expiry | Survives buffer clearing/restart; delivery requires a valid owning runtime and may be at-least-once across a crash. Acknowledgement does not prove work execution. Reconcile before action; uncertain work does not retry automatically. |
| Normal subagent completion/output | pi-subagents-owned | Aggregate orchestration wakes do not consume or duplicate normal provider output. Provider-owned completion can acknowledge its wake without a second aggregate message. |
| Monitor handles/output/status | Process-local; terminal state retained 15 minutes | A fresh manager cannot reattach an old process. Clean shutdown/switch drains owned monitors; abrupt death can leave unknown execution. Inspect external effects before authorizing another command. |
| Deleted ordinary/completed workflow controllers | No removal history | An absent ID does not identify whether it expired, completed, was deleted, or belongs to another store. Recovery snapshots are not a removal journal. Do not invent a reason. |

Disk persistence, scheduler activation, message acceptance, execution ownership, and observed work are separate facts. Inspection does not claim work, renew budgets, schedule a wake, or grant consent.

## Safe recovery

1. Inspect `/loop` → `View loops` or `LoopList` for current scope, lifetime, controller kind, and supported actions. A missing controller is not a tombstone.
2. For workflows, inspect the live state/revision/execution and declared outcomes. Use `WorkflowClaim` when required; use `WorkflowRevise` for an actionable route gap. Terminal and exhausted-budget recovery follows current pause policy, not generic resume.
3. For orchestration, inspect `OrchestrationGet` and provider evidence before cancellation or deletion. Do not replay uncertain dispatches or treat cancellation acknowledgement as proof of worker quiescence.
4. For an unavailable monitor after process loss, inspect logs, process state, and external side effects. No status means no recovered observation, not successful completion or permission to rerun.
5. Recreate expired/retired controllers only with explicit authority. Preserve unfinished progress and the actual evidence; do not silently extend a lifetime.

## Qualifying demand

Proposed, unrun: ask five operators to describe concrete workloads that current boundaries cannot support, and verify that each distinguishes persistence from scheduling, delivery, and execution. Consider a specific durability project only after two independent unmet workloads are documented. Participant recruitment, budget, and acceptance targets require approval; no outcomes or operator commitments are established.

Record the required unattended interval, acceptable wake loss/duplication, scope and competing runtimes, external side effects, restart expectations, and what must happen after ambiguous execution. Then evaluate one bounded daemon, outbox, scheduler-election, or recoverable-monitor proposal. None is implemented or authorized by this guide. Vendor capabilities and historical closed reports do not establish current demand or benefit.

## Test boundary

`test/runtime-continuity.test.ts` uses isolated file-backed stores, controlled notifications/schedulers, and mock process handles. It checks queue clearing versus durable accounting, unarmed scheduling, independent scheduler registrations, durable orchestration acknowledgement, manager-local handles, and absent-controller history. Existing session, notification, index, orchestration, and monitor suites cover generation fences, resume recovery, provider-owned output, and drained shutdown.

These tests do not simulate OS process death, prove orphan cleanup, implement unattended execution, or measure operator comprehension. See [testing](./TESTING.md) for the gate and [reference](./REFERENCE.md) for authority and mutation guarantees.
