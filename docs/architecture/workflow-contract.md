# Opt-in workflow contract

Workflow loops are a controller layer over dynamic loops and tasks. They are not the default model for schedules, events, or task backlogs.

## Ownership

- A `LoopEntry.workflow` owns the workflow definition, the persisted run state, and the embedded execution records.
- A state's `task` is embedded as a `WorkflowExecutionRecord` in the workflow run; no `TaskStore` record exists for workflow work.
- `WorkflowTransition` is the only settlement path: it validates the current runtime's lease, settles the active execution, advances state, and activates an unowned destination execution in one locked write.
- A self-loop is an explicit retry: it increments `transitionSeq` and `attemptsByState`, settles the prior execution, and activates a fresh unowned execution.
- Newly entered task phases are unowned claim boundaries so another project runtime can take the next phase immediately. Claimed executions carry a server-held lease (`ownerSessionId`/`ownerRuntimeId` + expiry). `WorkflowClaim` claims unowned work, renews a same-owner lease, or takes over an expired one; a live foreign lease is fail-closed.

## Definition

`WorkflowDefinition` version 1 contains an `initialState` and named states. A state has a prompt, optional `task`, outcome map `on`, optional positive `maxAttempts`, optional cron-only `loop` policy (`schedule`, optional positive `maxFires`, optional `startImmediately`), or a terminal status of `completed` or `paused`.

Every declared outcome must target a named state. Terminal states may not declare outcomes or loop policies. A state may be entered at most `maxAttempts` times when that limit is set. Only the active state's loop policy is armed; a scheduled wake retains the active execution until an explicit transition. A state-local `maxFires` pauses the workflow controller when exhausted. `startImmediately` opts into an initial idle wake; otherwise the first wake follows the cron schedule.

## Run invariants

- `currentState` always names a definition state.
- `transitionSeq` increases exactly once for every accepted transition.
- `attemptsByState` increases when a state is entered.
- `stateFireCounts` records delivered scheduled wakes by state and survives state transitions and recovery.
- `lastTransition` records source, destination, outcome, evidence, timestamp, and sequence.
- A task-bearing active state has an `activeExecution` matching `currentState`/`transitionSeq`; transition without a live own lease fails closed.
- Settled executions accumulate in `executionHistory` with evidence and timestamps.

## Adaptive definition revisions

A running workflow may add newly discovered states, redirect dependency edges, and revise future state work through a typed `WorkflowRevise` patch. Definition revisions, immutable prior-definition snapshots, rationale, and runtime actor evidence remain in `LoopStore`; revisions never create or update standalone tasks. Current materialized work is immutable, while outgoing edges from the current state and definitions of future states may change under revision/state/transition CAS and the current execution lease.

The implementation-ready operation schema, graph rules, concurrency matrix, failures, migration, and test plan are specified in [Adaptive workflow revision contract](workflow-revision-contract.md).

## Compatibility

Existing cron, event, hybrid, dynamic, and backlog loops have no `workflow` property and keep their current behavior. `LoopUpdate` remains the continuation API for legacy dynamic loops. Workflows persisted by v0.7.3 with `activeTaskId` normalize on load: the external link is dropped and a task-bearing state gains an unleased execution that must be claimed before transition. Pre-revision workflow runs normalize to definition revision 1 with empty revision history. Workflow tools do not require task-provider detection; external task providers serve standalone and auto tasks only.
