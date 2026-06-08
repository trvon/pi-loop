# pi-loop Goal State Schema

## Purpose

This document defines the reducer-owned state shape for Goals.

It builds on:

- `docs/architecture/state-machine-transition-map.md`
- `docs/architecture/state-machine-test-matrix.md`
- `docs/architecture/state-machine-reducer-event-model.md`

The objective is to let Goals compose:

- tasks
- loops
- monitors
- verification status

without reaching into runtime internals such as child-process handles, scheduler timer maps, event unsubscriptions, or Pi UI state.

---

## 1. Design constraints

The Goal schema should satisfy five constraints.

1. It must be reducer-owned data, not ad hoc runtime state.
2. It must compose existing entities rather than duplicate them.
3. It must support read-only verification before any autonomous mutation logic is added.
4. It must separate desired outcomes from execution mechanisms.
5. It must remain serializable and testable without Pi mocks.

In practice, this means a Goal should reference entities and interpret their state, rather than own live runtime objects.

---

## 2. Conceptual model

A Goal is a durable statement of intended progress over a bounded set of work.

A Goal should answer four questions:

1. **What are we trying to achieve?**
2. **What entities count as evidence of progress?**
3. **What counts as success, failure, or blocked state?**
4. **What verification should occur next?**

A Goal is therefore not just a label. It is a small stateful contract tying execution evidence to a desired outcome.

---

## 3. Core types

### 3.1 Goal lifecycle status

```ts
export type GoalStatus =
  | "pending"
  | "active"
  | "satisfied"
  | "blocked"
  | "failed"
  | "archived";
```

### Semantics

- `pending` — defined but not yet activated
- `active` — currently being pursued and still incomplete
- `satisfied` — completion criteria have been met
- `blocked` — progress is stalled on an unmet dependency or failed precondition
- `failed` — terminal negative outcome under current criteria
- `archived` — intentionally closed without further verification

`pending`, `active`, and `blocked` are the main nonterminal states.

---

### 3.2 Goal verification status

Goal lifecycle status should be separate from the current verification result.

```ts
export type GoalVerificationStatus =
  | "unknown"
  | "checking"
  | "verified"
  | "unverified"
  | "inconclusive";
```

### Why separate these?

A Goal may be `active` while its verification is `unknown` or `checking`.
A Goal may be `blocked` while its latest verification is `unverified`.
A Goal may become `satisfied` only after a `verified` result is observed.

This avoids collapsing operational progress and evidence quality into one field.

---

### 3.3 Goal entry

```ts
export interface GoalEntry {
  id: string;
  title: string;
  description: string;
  status: GoalStatus;
  verificationStatus: GoalVerificationStatus;

  createdAt: number;
  updatedAt: number;
  activatedAt?: number;
  resolvedAt?: number;

  scope: GoalScope;
  criteria: GoalCriteria;
  progress: GoalProgressSnapshot;
  verification: GoalVerificationState;

  metadata?: Record<string, unknown>;
}
```

This is the reducer-owned unit of record.

---

## 4. Goal scope

A Goal must explicitly declare which entities it cares about.

```ts
export interface GoalScope {
  taskIds?: string[];
  loopIds?: string[];
  monitorIds?: string[];

  tags?: string[];
  subjectPrefixes?: string[];

  includeFutureMatchingTasks?: boolean;
  includeFutureMatchingLoops?: boolean;
  includeFutureMatchingMonitors?: boolean;
}
```

### Guidance

Prefer explicit ids first.

Use broader matching such as `tags` or `subjectPrefixes` only when the goal is intended to absorb future work items dynamically.

### Rationale

The first prototype should remain conservative. Goals should not silently claim unrelated entities.

---

## 5. Goal criteria

Criteria define what the Goal considers success, failure, or blocked state.

```ts
export interface GoalCriteria {
  success: GoalSuccessCriteria;
  failure?: GoalFailureCriteria;
  blocked?: GoalBlockedCriteria;
}
```

### 5.1 Success criteria

```ts
export interface GoalSuccessCriteria {
  minCompletedTasks?: number;
  requiredTaskIds?: string[];
  requiredMonitorIdsCompleted?: string[];
  requiredLoopIdsPresent?: string[];
  requireNoPendingTasksInScope?: boolean;
  requireLatestVerificationPass?: boolean;
}
```

### 5.2 Failure criteria

```ts
export interface GoalFailureCriteria {
  anyMonitorIdsErrored?: string[];
  maxVerificationFailures?: number;
  failIfTaskIdsDeleted?: string[];
}
```

### 5.3 Blocked criteria

```ts
export interface GoalBlockedCriteria {
  blockedIfAllTasksCompletedButVerificationFails?: boolean;
  blockedIfNoScopedProgressSinceMs?: number;
  blockedIfRequiredLoopMissing?: boolean;
}
```

### Notes

These criteria are intentionally simple. The first version should use deterministic declarative rules rather than a scripting language.

---

## 6. Progress snapshot

Goals should cache a reducer-owned snapshot of relevant progress so verification can be explained, not merely asserted.

```ts
export interface GoalProgressSnapshot {
  totalTasks: number;
  pendingTasks: number;
  inProgressTasks: number;
  completedTasks: number;

  activeLoops: number;
  pausedLoops: number;

  runningMonitors: number;
  completedMonitors: number;
  erroredMonitors: number;
  stoppedMonitors: number;

  lastProgressAt?: number;
}
```

### Why cache this?

Because a Goal should be able to say why it is still active, blocked, or satisfied. The snapshot makes verification output auditable and stable in tests.

---

## 7. Verification state

Verification should retain the latest evidence, not just a boolean.

```ts
export interface GoalVerificationState {
  attempts: number;
  passes: number;
  failures: number;
  lastCheckedAt?: number;
  lastPassedAt?: number;
  lastFailedAt?: number;
  lastReason?: string;
  nextCheckAfter?: number;
}
```

### Interpretation

- `attempts` counts all verifier passes
- `passes` and `failures` support simple policy thresholds
- `lastReason` is human-readable justification for the last result
- `nextCheckAfter` supports future pacing without embedding scheduler internals in the goal itself

---

## 8. Reducer state shape

```ts
export interface GoalReducerState {
  nextId: number;
  goalsById: Record<string, GoalEntry>;
}
```

This follows the same pattern already adopted by task, loop, monitor, and notification reducers.

---

## 9. Event vocabulary

The Goal reducer should start with a small event set.

```ts
export type GoalEventType =
  | "GOAL_CREATED"
  | "GOAL_ACTIVATED"
  | "GOAL_PROGRESS_RECORDED"
  | "GOAL_VERIFICATION_STARTED"
  | "GOAL_VERIFICATION_PASSED"
  | "GOAL_VERIFICATION_FAILED"
  | "GOAL_BLOCKED"
  | "GOAL_UNBLOCKED"
  | "GOAL_SATISFIED"
  | "GOAL_FAILED"
  | "GOAL_ARCHIVED"
  | "GOAL_UPDATED";
```

### Event roles

- `GOAL_CREATED` — create the entry in `pending`
- `GOAL_ACTIVATED` — move `pending -> active`
- `GOAL_PROGRESS_RECORDED` — update derived progress snapshot
- `GOAL_VERIFICATION_STARTED` — set `verificationStatus=checking`
- `GOAL_VERIFICATION_PASSED` — update verification fields and potentially satisfy the goal
- `GOAL_VERIFICATION_FAILED` — update verification fields and potentially block/fail the goal
- `GOAL_BLOCKED` — explicit blocked transition
- `GOAL_UNBLOCKED` — blocked -> active
- `GOAL_SATISFIED` — terminal success
- `GOAL_FAILED` — terminal failure
- `GOAL_ARCHIVED` — terminal closure without claiming success
- `GOAL_UPDATED` — title/description/criteria/scope edits

---

## 10. Effect vocabulary

The Goal reducer should emit a small effect set.

```ts
export type GoalEffectType =
  | "PERSIST_GOAL"
  | "DELETE_GOAL"
  | "DISPATCH_EVENT"
  | "REQUEST_GOAL_VERIFICATION";
```

### Intent

- `PERSIST_GOAL` — save updated goal state
- `DELETE_GOAL` — only if we later support physical deletion
- `DISPATCH_EVENT` — derive follow-up events from verification logic
- `REQUEST_GOAL_VERIFICATION` — ask the coordinator/effect layer to run a read-only verification pass

The reducer should not directly schedule loops or inspect child processes.

---

## 11. Derived progress rules

Goals should interpret reducer-owned entity state through projection rules rather than ad hoc queries.

### 11.1 Task projection

Tasks in scope contribute:

- `pendingTasks`
- `inProgressTasks`
- `completedTasks`
- `lastProgressAt` from latest `updatedAt`

### 11.2 Loop projection

Loops in scope contribute:

- `activeLoops`
- `pausedLoops`
- loop existence checks for required loop criteria

### 11.3 Monitor projection

Monitors in scope contribute:

- `runningMonitors`
- `completedMonitors`
- `erroredMonitors`
- `stoppedMonitors`

### Rule

Projection should be a pure helper over reducer-owned snapshots, not a runtime query API.

---

## 12. Initial verification algorithm

The first goal verifier should remain intentionally modest.

### Input

- one `GoalEntry`
- current task reducer state
- current loop reducer state
- current monitor reducer state

### Output

- updated `GoalProgressSnapshot`
- one of:
  - `GOAL_VERIFICATION_PASSED`
  - `GOAL_VERIFICATION_FAILED`
  - `GOAL_BLOCKED`
  - no terminal transition yet

### Suggested order

1. project scoped entities into a progress snapshot
2. update `lastCheckedAt`
3. check hard failure criteria first
4. check success criteria second
5. check blocked criteria third
6. otherwise remain `active` with `verificationStatus=unverified` or `inconclusive`

This ordering keeps failure and success decisions deterministic.

---

## 13. Allowed and forbidden dependencies

### Goal reducer may depend on

- goal reducer state
- serializable event payloads
- projected reducer-owned task/loop/monitor snapshots provided by the coordinator

### Goal reducer may not depend on

- `ChildProcess` handles
- scheduler timer maps
- event unsubscriber handles
- `AbortController`
- Pi UI context
- direct `sendMessage()` or eventbus calls
- the raw `MonitorProcess` map

This boundary is essential if goals are to remain testable and replayable.

---

## 14. Initial invariants

The first Goal implementation should enforce these invariants.

1. Goal ids are monotonic.
2. Terminal goals (`satisfied`, `failed`, `archived`) do not transition back to `active` without an explicit reopen event if such an event is later added.
3. `resolvedAt` is set exactly when entering a terminal lifecycle state.
4. `verificationStatus=verified` implies the last verification result was a pass.
5. `verificationStatus=checking` is nonterminal.
6. Goal progress is derived from scoped reducer-owned entity state, not from runtime handles.
7. A Goal may reference future matching tasks only when that intent is explicit in `GoalScope`.

---

## 15. Suggested storage shape

If and when goals are persisted independently, the storage shape should mirror the existing reducer-backed stores.

```ts
export interface GoalStoreData {
  nextId: number;
  goals: GoalEntry[];
}
```

No separate runtime-only goal fields should be serialized.

---

## 16. Relationship to tasks #12 and #13

### Task #12 — Prototype goal verifier loop

This schema gives `#12` a narrow target:

- implement projection helpers
- implement read-only verification
- emit `REQUEST_GOAL_VERIFICATION` or derived goal events
- do not yet mutate unrelated loop/task/monitor runtime behavior

### Task #13 — Document state machine migration

This schema also gives `#13` a stable anchor for the final architecture narrative:

- reducers own state
- coordinator owns cross-entity dispatch
- verifiers consume reducer-owned snapshots
- goals remain declarative rather than runtime-coupled

---

## 17. Recommended next implementation order

1. add `GoalEntry` types and reducer state definitions
2. add pure goal reducer tests for create/activate/update/block/satisfy/fail/archive
3. add projection helpers over task/loop/monitor reducer states
4. implement a read-only verifier that emits goal events
5. only afterward consider autonomous follow-up behavior

---

## 18. Summary

We define a Goal as a reducer-owned contract over scoped task, loop, and monitor evidence.

Its state should remain:

- declarative
- serializable
- projection-driven
- verification-oriented
- independent of runtime internals

This gives the next stage of work a disciplined base for adding goal verification without collapsing back into ad hoc control flow.