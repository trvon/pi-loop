# pi-loop State Tracking Test Matrix

## Purpose

This matrix turns the state inventory in `docs/architecture/state-machine-transition-map.md`
into a concrete test plan for the reducer/state-machine migration.

The goal is to:

- lock down current behavior before refactoring
- separate entity transition tests from coordination scenario tests
- make hidden lifecycle phases observable via assertions
- ensure future Goal orchestration builds on a reliable state core

## Test layers

We will test state tracking at three layers:

1. **Entity transition tests**
   - task, loop, monitor, and notification transitions in isolation
2. **Invariant tests**
   - properties that must always hold across transitions
3. **Scenario tests**
   - cross-entity coordination paths and lifecycle races

## 1. Entity transition tests

### 1.1 Task entity transitions

| ID | Case | Start | Event | Expected end state | Current coverage | Target file |
|---|---|---|---|---|---|---|
| T-01 | create native task | none | `TaskCreate` | `pending` | partial | `test/index.test.ts` |
| T-02 | quick-create native task | none | `/tasks some text` | `pending` | partial | `test/index.test.ts` |
| T-03 | start task | `pending` | `TaskUpdate(status=in_progress)` | `in_progress` | missing direct test | `test/index.test.ts` |
| T-04 | complete pending task | `pending` | `TaskUpdate(status=completed)` | `completed` with `completedAt` | partial | `test/index.test.ts` |
| T-05 | complete in-progress task | `in_progress` | `TaskUpdate(status=completed)` | `completed` with `completedAt` | missing direct test | `test/index.test.ts` |
| T-06 | reopen completed task | `completed` | `TaskUpdate(status=pending)` | `pending` | missing | `test/index.test.ts` |
| T-07 | delete task | any existing | `TaskDelete` | removed | partial | `test/index.test.ts` |
| T-08 | prune completed tasks | mixed task set | `cleanDoneTasks()` / `sweepCompleted()` | completed removed, active retained | partial | `test/index.test.ts` / `test/task-store.test.ts` if added |
| T-09 | monotonic ids after prune | completed tasks swept | `TaskCreate` | next id strictly increases | covered | `test/index.test.ts` |
| T-10 | completedAt semantics on reopen | completed then reopened | `TaskUpdate(status=pending)` | define whether `completedAt` persists or clears | currently unspecified | state-model decision |

### 1.2 Loop entity transitions

| ID | Case | Start | Event | Expected end state | Current coverage | Target file |
|---|---|---|---|---|---|---|
| L-01 | create cron loop | none | `LoopCreate(trigger=cron)` | `active` and armed | partial | `test/index.test.ts` / `test/store.test.ts` |
| L-02 | create event loop | none | `LoopCreate(trigger=event)` | `active` and subscribed | partial | `test/index.test.ts` / `test/trigger-system.test.ts` |
| L-03 | create hybrid loop | none | `LoopCreate(trigger=hybrid)` | `active`, armed, subscribed | partial | `test/index.test.ts` / `test/trigger-system.test.ts` |
| L-04 | pause active loop | `active` | `LoopDelete(action=pause)` | `paused`, unsubscribed, disarmed | covered wrapper only | `test/index.test.ts` |
| L-05 | resume paused loop | `paused` | interactive resume / direct store+trigger path | `active`, re-armed, re-subscribed | missing | `test/index.test.ts` |
| L-06 | delete loop | `active` or `paused` | `LoopDelete(delete)` | removed from store and trigger system | covered | `test/index.test.ts` |
| L-07 | fire recurring loop | `active` recurring | `onLoopFire` | `fireCount++`, remains active | partial | `test/scheduler.test.ts` / `test/trigger-system.test.ts` |
| L-08 | fire one-shot loop | `active` non-recurring | `fire` | removed after delivery path | partial | `test/trigger-system.test.ts` / `test/injection.test.ts` |
| L-09 | maxFires terminal delete | recurring + limit | final fire | removed immediately | covered | `test/index.test.ts` / `test/trigger-system.test.ts` |
| L-10 | expiry delete | expired active loop | scheduler/session prune | removed | partial | `test/scheduler.test.ts` / `test/store.test.ts` |
| L-11 | resume-time event loop cleanup | persisted event/hybrid loop from prior session | `expireEventLoops()` | removed | covered store-level only | `test/store.test.ts` |
| L-12 | backlog loop zero-pending delete | `taskBacklog` loop active | pending count -> 0 | removed | covered | `test/index.test.ts` |

### 1.3 Monitor entity transitions

| ID | Case | Start | Event | Expected end state | Current coverage | Target file |
|---|---|---|---|---|---|---|
| M-01 | create monitor | none | `MonitorCreate` | `running` | covered | `test/index.test.ts` |
| M-02 | normal completion | `running` | child close code 0 | `completed` retained briefly | covered indirectly | `test/index.test.ts` / `test/monitor-manager.test.ts` |
| M-03 | error completion | `running` | child close nonzero | `error` retained briefly | partial | `test/monitor-manager.test.ts` |
| M-04 | child error path | `running` | child `error` | `error` retained, callbacks cleared | missing direct test | `test/monitor-manager.test.ts` |
| M-05 | stop monitor | `running` | `MonitorStop` | `stopped` | covered | `test/index.test.ts` |
| M-06 | retain completed monitor | `completed` | before 30s retention expiry | still listed | partial | `test/index.test.ts` |
| M-07 | prune completed monitor | `completed` | after retention timeout | removed | missing direct test | `test/monitor-manager.test.ts` |
| M-08 | onDone callback registration | `running` | `onComplete()` | callback stored | missing direct test | `test/monitor-manager.test.ts` |
| M-09 | onDone direct delivery after completion | `completed` | registered callback or immediate completed registration | wake delivered once | covered | `test/index.test.ts` |
| M-10 | onDone does not depend on event dispatch | `completed` | event suppressed | direct wake still delivered | covered | `test/index.test.ts` |

### 1.4 Notification / wake entity transitions

| ID | Case | Start | Event | Expected end state | Current coverage | Target file |
|---|---|---|---|---|---|---|
| N-01 | idle immediate delivery | none | `loop:fire` while idle | sent immediately | covered | `test/injection.test.ts` |
| N-02 | active-agent buffering | none | `loop:fire` while agent active | queued, not sent yet | covered | `test/injection.test.ts` |
| N-03 | flush on idle | queued | `agent_end` / idle flush | delivered | covered | `test/injection.test.ts` |
| N-04 | recurring dedupe | queued recurring | newer same-loop fire | prior pending replaced | covered | `test/injection.test.ts` |
| N-05 | one-shot isolation | queued one-shot | separate one-shot fire | both preserved independently | missing explicit test | `test/injection.test.ts` |
| N-06 | autoTask drop on zero pending at delivery | queued autoTask wake | pending count -> 0 | dropped and cleanup requested | covered | `test/injection.test.ts` |
| N-07 | force flush on agent_end even with pending messages | queued wake | `agent_end` with `hasPendingMessages()` true | delivered | covered | `test/index.test.ts` |
| N-08 | clear on session switch | queued wake | `session_switch` | cleared, not delivered | missing direct test | `test/injection.test.ts` |
| N-09 | clear on shutdown | queued wake | `session_shutdown` | cleared, not delivered | missing direct test | `test/injection.test.ts` |

## 2. Invariant tests

These are properties that should remain true across many transitions.

### 2.1 Task invariants

| ID | Invariant | Assertion |
|---|---|---|
| TI-01 | ids are monotonic | creating after prune never reuses an old id |
| TI-02 | at most one status per task | task cannot be both `completed` and counted as pending/in-progress |
| TI-03 | pending count excludes completed | `pendingCount()` only counts `pending` and `in_progress` |
| TI-04 | pruning preserves active work | sweeping completed tasks never removes pending/in-progress tasks |
| TI-05 | retention policy is event-driven, not implicit | completed tasks remain listed until an explicit cleanup trigger occurs |

### 2.2 Loop invariants

| ID | Invariant | Assertion |
|---|---|---|
| LI-01 | terminal loops do not remain active | non-recurring, expired, and maxFires-complete loops are removed |
| LI-02 | paused loops do not fire | paused loops have no active scheduler/event behavior |
| LI-03 | backlog loops only self-delete on zero pending | ordinary `tasks:created` watchers stay alive |
| LI-04 | recurring fire count is monotonic | `fireCount` never decreases |
| LI-05 | max loop count enforced | cannot exceed 25 active loops |

### 2.3 Monitor invariants

| ID | Invariant | Assertion |
|---|---|---|
| MI-01 | monitor has one terminal status | running cannot transition to multiple terminal statuses |
| MI-02 | onDone wake delivered at most once | direct callback + event path do not duplicate the wake |
| MI-03 | stopped monitors do not later complete | stop path cannot also emit completion wake |
| MI-04 | retention timeout eventually prunes completed/error monitors | terminal monitors do not linger indefinitely |

### 2.4 Notification invariants

| ID | Invariant | Assertion |
|---|---|---|
| NI-01 | recurring pending wake key is unique per loop | one recurring loop has at most one buffered wake |
| NI-02 | one-shot wake key uniqueness | one-shot deliveries do not overwrite each other |
| NI-03 | no delivery while agent active | queued wakes do not send until flush conditions are met |
| NI-04 | dropped autoTask wake requests cleanup | zero-pending autoTask drops trigger cleanup side effect |
| NI-05 | session switch clears buffered wakes | pending notifications are not delivered into a new session unexpectedly |

## 3. Scenario tests

These validate cross-entity coordination and races.

### 3.1 Backlog orchestration scenarios

| ID | Scenario | Expected outcome | Current coverage |
|---|---|---|---|
| S-01 | create 5 native tasks | worker loop auto-created once | covered |
| S-02 | create 6th+ task | no duplicate worker loop | covered |
| S-03 | agent busy during worker bootstrap | wake buffered then flushed at `agent_end` | covered |
| S-04 | queue clears | worker loop auto-deletes | covered |
| S-05 | manual `taskBacklog` loop queue clears | manual backlog loop auto-deletes | covered |
| S-06 | plain `tasks:created` watcher queue clears | ordinary watcher stays active | covered |

### 3.2 Monitor completion scenarios

| ID | Scenario | Expected outcome | Current coverage |
|---|---|---|---|
| S-07 | monitor completes while idle | model receives onDone wake | covered |
| S-08 | monitor completes while agent busy | wake buffered and later delivered | partial |
| S-09 | monitor event dispatch missed | direct callback path still wakes model | covered |
| S-10 | onDone loop created after monitor already finished | immediate direct delivery or expiry behavior is correct | partial |

### 3.3 Task cleanup scenarios

| ID | Scenario | Expected outcome | Current coverage |
|---|---|---|---|
| S-11 | successful `git commit` | completed tasks pruned, ids preserved | covered |
| S-12 | failed commit | completed tasks retained | covered |
| S-13 | non-commit bash tool | completed tasks retained | covered |
| S-14 | zero-pending autoTask drop | completed tasks swept and wake not delivered | covered |

### 3.4 Session lifecycle scenarios

| ID | Scenario | Expected outcome | Current coverage |
|---|---|---|---|
| S-15 | session switch with queued wakes | queued notifications cleared | missing |
| S-16 | session shutdown with queued wakes | queued notifications cleared | missing |
| S-17 | resume with stale event/hybrid loops | expired event/hybrid loops pruned | partial |
| S-18 | memory scope new non-resume session | loops cleared | missing direct integration |
| S-19 | session-scoped storage path | tasks/loops isolated by session id | covered for tasks, partial for loops |

## 4. Priority order for implementation

### Phase A — Close the highest-value gaps first

These gaps most directly reduce refactor risk:

1. `T-03`, `T-05`, `T-06`, `T-10`
2. `L-05`, `L-08`
3. `M-04`, `M-07`, `M-08`
4. `N-05`, `N-08`, `N-09`
5. `S-08`, `S-10`, `S-15`, `S-16`, `S-18`

### Phase B — Extract testable helpers before reducer migration

Once Phase A closes, we should be able to extract helper functions or reducers for:

- task transition application
- loop terminal-deletion rules
- notification queue keying and flush eligibility
- monitor completion side effects

### Phase C — Add reducer-specific tests

After reducer extraction, add pure transition tests with no Pi mocks:

- `reduceTask(state, event)`
- `reduceLoop(state, event)`
- `reduceMonitor(state, event)`
- `reduceNotification(state, event)`

Each should assert:

- next state
- emitted effects
- no hidden mutation of unrelated entities

## 5. Goal feature prerequisites

The Goal feature should not land until these test conditions are met:

- all Phase A gaps above are closed
- notification delivery is deterministic under idle/active/session-switch conditions
- backlog loop ownership and cleanup are explicit and tested
- monitor completion semantics are single-delivery and race-resistant
- task pruning policy is stable and monotonic-id safe

## 6. Minimum deliverables for the next subtasks

### Task #3 — Add entity transition tests

Deliver:

- direct tests for missing task, loop, monitor, and notification transitions
- no production behavior changes required

### Task #4 — Add scenario state tests

Deliver:

- end-to-end race and lifecycle scenarios from section 3
- especially session-switch and monitor-busy completion paths

### Task #5 — Design reducer event model

Must align reducer event names to the transition cases above so the matrix remains the stable contract.

## 7. Summary

This matrix turns the current behavior into a test contract.

The most important principle for the refactor is:

> Preserve behavior first, then simplify representation.

If a future reducer/state-machine change cannot be mapped back to one of the transition or scenario rows in this document, it is probably changing semantics, not just structure.