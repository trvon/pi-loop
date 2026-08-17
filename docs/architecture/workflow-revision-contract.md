# Adaptive workflow revision contract

## Goal and authority

A running workflow may discover work or replace a future requirement that was not known when `WorkflowCreate` authored revision 1. The revision must become durable workflow state, not transition evidence and not a standalone task.

`LoopStore` remains the sole authority for workflow definitions, embedded executions, revision history, and leases. `TaskStore`, task RPC, and `/tasks` never participate in a workflow revision.

## Chosen surface

The public mutation is `WorkflowRevise` with a typed, constrained patch. It is not full-definition replacement, RFC 6902 JSON Patch, or a separate `WorkflowAddRequirement` tool.

Full replacement is rejected because omission, renaming, or an unrelated edit can silently discard work. Making replacement safe would require computing and policing the same semantic diff that the typed patch expresses directly. A requirement-specific tool is too narrow because one discovery commonly needs one atomic change containing a new state, a redirected dependency edge, and revised future instructions.

```ts
type WorkflowRevisionChange =
  | {
      op: "add_state";
      stateId: string;
      state: WorkflowStateDefinition;
    }
  | {
      op: "revise_state";
      stateId: string;
      prompt?: string;
      task?: WorkflowTaskDefinition;
      loop?: WorkflowStateLoopDefinition;
      maxAttempts?: number;
    }
  | {
      op: "add_transition";
      from: string;
      outcome: string;
      to: string;
    }
  | {
      op: "redirect_transition";
      from: string;
      outcome: string;
      expectedTo: string;
      to: string;
    };
```

```text
WorkflowRevise({
  id: string,
  expectedRevision: integer >= 1,
  expectedState: string,
  expectedTransitionSeq: integer >= 0,
  reason: string,
  changes: WorkflowRevisionChange[]
})
```

`reason` is trimmed and must contain 1–1000 characters. A revision contains 1–64 changes. Runtime identity is resolved by the server; callers never provide an actor, lease, or bearer token.

The state and transition-sequence expectations are required in addition to `expectedRevision`. A transition changes the active state without changing the definition revision, so revision-only CAS cannot reject a patch prepared against a state that has already advanced.

## Persisted state

`WorkflowDefinition.version` remains 1. Definition schema version and run-local definition revision are separate concepts.

```ts
interface WorkflowDefinitionRevision {
  revision: number;
  definition: WorkflowDefinition;
  reason: string;
  supersededAt: number;
  supersededBy: WorkflowRuntimeActor;
  changes: WorkflowRevisionChange[];
}

interface WorkflowRunState {
  definition: WorkflowDefinition;
  definitionRevision: number;
  revisionHistory: WorkflowDefinitionRevision[];

  // Existing run fields remain authoritative.
  currentState: string;
  transitionSeq: number;
  stateEnteredAt: number;
  attemptsByState: Record<string, number>;
  stateFireCounts: Record<string, number>;
  activeExecution?: WorkflowExecutionRecord;
  executionHistory?: WorkflowExecutionRecord[];
  waitingMonitor?: WorkflowMonitorWait;
  lastTransition?: WorkflowTransitionRecord;
}
```

Revision 1 is created with empty history. Accepting a patch against revision N appends a deep-cloned snapshot of definition N plus the rationale, actor, timestamp, and accepted patch, then stores the resulting definition as revision N+1.

Invariants:

- `definitionRevision === revisionHistory.length + 1`.
- History records are contiguous and ordered from revision 1.
- History snapshots and accepted changes are deep-cloned and never rewritten.
- One accepted `WorkflowRevise` increments the revision exactly once, regardless of patch length.
- At most 32 definition revisions are allowed. Revision 33 is rejected; history is never pruned silently.
- A serialized definition may contain at most 65,536 UTF-8 bytes, measured as `Buffer.byteLength(JSON.stringify(definition), "utf8")`. `WorkflowCreate` and `WorkflowRevise` enforce the same bound.
- Revision metadata remains attached while the workflow is active or paused. Existing completed-workflow deletion semantics are unchanged; this feature does not introduce a second audit store.

## Patch semantics

Changes are declarative and order-independent. Validation rejects overlapping operations, then application uses this fixed order:

1. add states;
2. revise existing state content;
3. add or redirect edges;
4. validate the complete resulting definition and graph.

At most one `add_state` or `revise_state` may target a state ID in one patch. At most one edge operation may target a `(from, outcome)` pair. An add and revision may not target the same state. Every change must alter the definition; no-op patches are rejected rather than consuming revision history.

### Allowed

- Add a uniquely named state.
- Add a uniquely named outcome edge to a nonterminal state.
- Redirect an existing edge when its target exactly matches `expectedTo`.
- Revise `prompt`, `task`, `loop`, or `maxAttempts` on a non-current state.
- Revise a previously executed, non-current state prospectively. Settled execution records remain unchanged; a later entry uses the revised state definition.
- Add or redirect an outgoing edge from `currentState` when the caller owns its live execution lease.
- Revise a future terminal state's prompt while preserving its terminal status.

### Forbidden in the initial contract

- Full-definition replacement or generic JSON pointers.
- Remove or rename a state, outcome, task, loop, or attempt policy.
- Change `version`, `initialState`, or an existing state's terminal status.
- Revise the current state's prompt, task, loop, or `maxAttempts`. Those fields have already materialized as the active execution and wake contract.
- Mutate `activeExecution`, its lease, `executionHistory`, counters, `transitionSeq`, `stateEnteredAt`, `waitingMonitor`, `lastTransition`, dynamic-loop state, or loop status through a revision.
- Revise while the current workflow is terminal or has an active monitor wait.
- Consume a revision for a byte-identical state or edge operation.

A changed future `maxAttempts` must be greater than the state's existing `attemptsByState` count. A changed future loop `maxFires` must be greater than its existing `stateFireCounts` count. This prevents a revision from making the next entry or wake exhausted on arrival.

## Dependency-edge semantics

The workflow remains a finite-state controller, not a TaskStore dependency DAG.

- `state.on[outcome] = target` means accepting that outcome enters `target`.
- Multiple incoming edges are alternative routes, not an AND-join.
- Inserting a prerequisite on one route uses `redirect_transition` for that route and an edge from the inserted state to the prior target.
- If every route into downstream work must be gated, the patch must redirect every applicable incoming edge explicitly.
- Cycles and bounded self-rework remain legal.

The resulting graph must pass existing definition validation. Revision validation additionally requires:

1. all newly introduced state IDs and outcome names match `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` and are not `__proto__`, `prototype`, or `constructor`; creation applies the same rule so later lookup never depends on inherited record keys;
2. all referenced source and target states exist after state additions;
3. edge sources are nonterminal;
4. every newly added state is reachable from `currentState` in the resulting graph;
5. every newly added state has a path to either a pre-revision state or a terminal state;
6. every redirected edge has a path from its new target to its exact prior target;
7. no revised attempt or fire limit is already exhausted;
8. the resulting serialized definition is within the size bound.

The contract does not add a global terminal-reachability requirement because version-1 definitions currently permit long-running cyclic workflows. Redirect preservation prevents an inserted requirement from silently dropping the downstream work that the route previously represented.

## Authorization and active execution

Every revision requires a server-resolved active runtime actor.

For a task-bearing current state:

- `activeExecution` must be active and match `currentState` and `transitionSeq`;
- an unowned execution must be claimed first with `WorkflowClaim`;
- an expired lease must be reclaimed;
- a live foreign lease fails closed;
- revision does not renew, transfer, settle, cancel, or replace the lease or execution.

For a non-task current state, an active runtime actor is required but no synthetic lease is created. A paused, nonterminal controller may be revised under the same authorization rules and remains paused. A terminal state may not be revised.

A successful revision preserves the current active execution byte-for-byte, including lease and timestamps. Revised task metadata is applied only when that future state is next entered.

## Atomic reducer and store transition

The pure operation is:

```ts
reviseWorkflowRun(
  run: WorkflowRunState,
  input: {
    expectedRevision: number;
    expectedState: string;
    expectedTransitionSeq: number;
    reason: string;
    changes: WorkflowRevisionChange[];
    actor?: WorkflowRuntimeActor;
  },
  at: number,
): WorkflowRevisionResult;
```

The corresponding loop reducer event is `LOOP_WORKFLOW_REVISED`. Its payload contains the ID, all expected values, reason, typed changes, and the server-resolved actor.

`LoopStore.reviseWorkflow` reloads and locks the latest store, validates the expected tuple and authorization, applies the complete patch as one reducer event, and persists one atomic rename. The event may change only:

- `workflow.definition`;
- `workflow.definitionRevision`;
- `workflow.revisionHistory`;
- `LoopEntry.updatedAt`.

It does not wake, pause, resume, rearm, or modify the scheduler. The current tool result tells the active agent to continue through the revised outcome. A future state's cadence is armed normally when that state is entered.

There is no TaskStore write or cross-store effect.

## Concurrency matrix

`WorkflowTransition` extends its internal expected tuple with `definitionRevision`.

| Winner | Loser | Required result |
|---|---|---|
| Revision commits first | Transition prepared against the prior definition | Transition rejects its stale `definitionRevision`; inspect and retry. |
| Transition commits first | Revision prepared against the prior active state | Revision rejects `expectedState` or `expectedTransitionSeq`; inspect and re-author against the new state. |
| Revision A commits first | Revision B expected the same revision | B rejects with `revision_conflict`. |
| Monitor wait attaches first | Revision | Revision rejects `monitor_wait_active`. |
| Revision commits before monitor attachment | Monitor attachment | Attachment may proceed because current execution/state are unchanged. |
| Same-owner lease renewal commits first | Revision | Revision may proceed with the current live lease. |
| Expired lease is taken by another runtime first | Revision from prior owner | Revision rejects `lease_owned_elsewhere`. |

Validation order inside the lock is:

1. loop and workflow existence;
2. definition revision CAS;
3. expected state and transition-sequence CAS;
4. terminal, monitor-wait, and revision-limit checks;
5. actor and lease authorization;
6. patch, graph, attempt/fire-limit, and size validation;
7. one reducer event and one persistence write.

A stale expected revision is reported before lease errors so a caller that lost the definition race receives the recovery action that can actually make its patch current.

## Failures and recovery

Internal failures are structured even if the initial tool renders text.

| Code | Meaning | Recovery |
|---|---|---|
| `loop_not_found` | ID is absent | Inspect `LoopList`. |
| `not_workflow` | ID is not workflow-owned | Use the matching loop tool. |
| `revision_conflict` | `expectedRevision` is stale | Inspect revision and re-author the patch. |
| `run_conflict` | expected state or transition sequence is stale | Inspect current state and decide whether the discovery still applies. |
| `terminal_workflow` | current state is terminal | Create new work explicitly if needed. |
| `monitor_wait_active` | current execution is waiting on a monitor | Revise after the wait clears. |
| `revision_limit_reached` | revision 32 already exists | Pause and create a successor workflow; do not prune history. |
| `actor_required` | no active session runtime | Retry after session initialization. |
| `execution_missing` | active execution and state disagree | Repair/recover workflow state before revision. |
| `execution_unowned` | task work has no lease | Call `WorkflowClaim`. |
| `lease_expired` | current lease expired | Reclaim, then retry. |
| `lease_owned_elsewhere` | another runtime owns live work | Let that owner revise or wait for expiry. |
| `invalid_patch` | shape, overlap, no-op, count, key, or limit is invalid | Correct the listed change. |
| `current_state_immutable` | patch changes materialized current work | Add/redirect edges or revise future work instead. |
| `state_conflict` | state add/revision precondition failed | Inspect the named state and re-author. |
| `edge_conflict` | edge add/redirect precondition failed | Inspect the named edge and use its current target. |
| `dependency_not_preserved` | redirected route cannot reach its prior target | Connect the inserted requirement back to downstream work. |
| `graph_invalid` | resulting definition is structurally invalid | Correct the reported graph error. |
| `definition_too_large` | resulting JSON exceeds 65,536 bytes | Split the workflow or shorten state content. |

Required conflict messages include both expected and current values. Rejection is byte-preserving: no revision, history, execution, lease, counter, timestamp, trigger, or widget mutation occurs.

Successful output includes revision N→N+1, reason, added/revised states, edge changes, preserved current execution ID, and the next action. `formatWorkflowSummary`, notifications, create/claim/transition results, and `LoopList` display `Definition revision: N`, `State: <id>`, and `Transition sequence: N` so callers can populate the next CAS tuple.

## Restart normalization and corruption handling

Load normalization runs alongside the existing v0.7.3 `activeTaskId` normalization and must not be bypassed by its early-return path.

- If both revision fields are absent, normalize to `definitionRevision: 1` and `revisionHistory: []`.
- If exactly one revision field is present, fail closed as malformed persisted workflow state.
- Existing revision metadata must have a positive integer revision, an array of contiguous records starting at 1, and `definitionRevision === revisionHistory.length + 1`.
- Malformed or partial audit metadata is store corruption; it is not silently reset.
- Normalization does not bump `WorkflowDefinition.version` and need not rewrite the file until the next locked mutation.

The new revision, patch, failure, and result types are exported through `@trevonistrevon/pi-loop/api`; consumers never import internal reducer/store modules.

## Transition map

```text
WorkflowCreate
  definitionRevision = 1
  revisionHistory = []
  active state/execution established

WorkflowRevise(expected revision/state/sequence, reason, changes)
  ├─ stale tuple / unauthorized / invalid patch -> reject, byte-preserving
  └─ accepted under LoopStore lock
       ├─ append immutable snapshot of prior definition
       ├─ apply typed changes
       ├─ definitionRevision += 1
       ├─ preserve active execution and run state
       └─ no wake or TaskStore effect

WorkflowTransition(expected definition revision + existing run tuple)
  ├─ stale definition -> reject and inspect
  └─ accepted
       ├─ settle source execution
       ├─ follow the revised outcome edge
       └─ activate destination execution unowned
```

## Verification plan

Reducer tests cover each operation, fixed application ordering, graph constraints, no-op/overlap rejection, immutable deep-cloned history, current-execution preservation, prospective edits, authorization, and revision/size/attempt/fire limits.

Store tests cover two-writer revision CAS, revision-versus-transition races in both orders, transition fencing by definition revision, restart round-trip, legacy normalization, malformed-history rejection, and byte-identical state after every rejection.

Tool tests cover the typed `changes` schema, absence of actor/token/full-definition fields, exact success/failure guidance, visible revision/state/sequence values, and claim-first behavior.

The task-10 RED integration test remains opt-in until task #12 begins production implementation:

```bash
PI_LOOP_WORKFLOW_REVISION_RED=1 npm test -- --run test/workflow-task-integration.test.ts -t "durably inserts discovered work"
```

Task #12 removes the opt-in gate before turning the regression green. The test changes from full definition replacement to:

```json
[
  { "op": "add_state", "stateId": "validate_handoff", "state": { "...": "..." } },
  {
    "op": "redirect_transition",
    "from": "investigate",
    "outcome": "requirements_known",
    "expectedTo": "implement",
    "to": "validate_handoff"
  },
  {
    "op": "revise_state",
    "stateId": "implement",
    "prompt": "Implement the revised requirement.",
    "task": { "subject": "Implement workflow", "description": "Leave destination work unowned until claimed." }
  }
]
```

It retains the revision 1→2, exact resulting definition, immutable history/rationale, active-execution preservation, stale-write rejection, revised dependency path, and empty TaskStore assertions.

The goal-seeded live scenario requires exactly one `WorkflowRevise` call containing `add_state`, `redirect_transition`, and `revise_state`; it no longer accepts an unspecified alternative tool name. Newly entered phases still require `WorkflowClaim`, and standalone task operations remain forbidden.
