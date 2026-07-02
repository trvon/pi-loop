# pi-loop State Machine Migration

## Purpose

This document records the migration from ad hoc runtime control flow toward reducer-driven state handling in `pi-loop`.

It is the capstone document for the architecture work captured in:

- `docs/architecture/state-machine-transition-map.md`
- `docs/architecture/state-machine-test-matrix.md`
- `docs/architecture/state-machine-reducer-event-model.md`

The goal of this document is to explain:

1. what the original runtime looked like
2. what has already been extracted
3. what remains to be integrated
4. how the coordinator should be adopted safely
5. what risks still exist

---

## 1. Background

The original `pi-loop` runtime was correct in many important respects, but its control flow was concentrated in a small number of imperative modules, especially `src/index.ts`, `src/store.ts`, `src/task-store.ts`, and `src/monitor-manager.ts`.

This architecture had several strengths:

- straightforward implementation
- strong feature velocity
- pragmatic reliability fixes added close to the bug sites

However, it also had several long-term costs:

- state was distributed across stores, runtime maps, booleans, timers, and callbacks
- cross-entity coordination rules were implicit rather than named
- verification of lifecycle invariants required integration reasoning rather than local reducer reasoning
- new features such as Goals risked growing additional ad hoc coordination paths unless a state model was introduced first

The migration therefore aimed to preserve runtime behavior while replacing hidden control flow with explicit events, reducer-owned state, and effect-driven coordination.

---

## 2. Migration principles

Five principles guided the migration.

### 2.1 Preserve semantics first

The migration is not a feature rewrite. It is a representation change.

Every reducer extraction was required to preserve:

- existing tool behavior
- current cleanup semantics
- current buffering/dedupe rules
- current session lifecycle behavior
- current test suite expectations

### 2.2 Add tests before extraction

The migration followed a test-first sequence:

1. map state and transitions
2. define invariant and scenario matrix
3. add entity transition tests
4. add scenario tests
5. extract reducers behind those tests

This ordering reduced the likelihood of silently changing semantics while improving internal structure.

### 2.3 Keep reducers pure

Reducers own logical state only.

They do **not** own:

- child process handles
- scheduler timer maps
- event subscription unsubscriber functions
- Pi UI contexts
- direct `sendMessage()` calls
- `AbortController` instances

These remain in the effect layer or runtime wrapper modules.

### 2.4 Keep state local by entity family

The migration intentionally avoided a single global FSM.

Instead, it uses separate reducer families for:

- tasks
- loops
- notifications
- monitors

### 2.5 Name coordination rules explicitly

The original runtime embedded many coordination rules directly in imperative logic.

The migration names them as explicit events and effects so they can be tested and reasoned about separately.

---

## 3. Original runtime shape

Before reducer extraction, the most important state was spread across the following surfaces.

### 3.1 Tasks

Logical task state lived in `TaskStore` and native task tool handlers.

Hidden coordination included:

- pruning after successful `git commit`
- worker-loop creation at backlog threshold
- worker-loop cleanup on zero pending tasks

### 3.2 Loops

Loop state was partly persisted and partly runtime-owned.

Visible loop fields included:

- `status`
- `trigger`
- `fireCount`
- `expiresAt`

Hidden loop runtime state included:

- scheduler fire-time tracking
- event subscriptions
- debounce timers
- notification queueing behavior

### 3.3 Notifications

Notification behavior was correct but previously implemented directly in `src/index.ts` through local maps and booleans.

That made delivery rules harder to isolate and test as a pure state machine.

### 3.4 Monitors

Monitor logical lifecycle and child-process runtime were tightly coupled.

The migration needed to separate:

- logical lifecycle (`running`, `completed`, `error`, `stopped`)
- runtime process ownership and signal handling

### 3.5 Cross-entity coordination

Rules such as:

- backlog threshold -> worker loop creation
- monitor completion -> wake delivery
- session switch -> queue clearing
- zero pending tasks -> backlog loop deletion

were all present, but not yet formalized as named coordinator transitions.

---

## 4. Architecture artifacts produced during migration

The migration generated a layered architecture record.

### 4.1 Transition inventory

`docs/architecture/state-machine-transition-map.md`

This document identifies:

- explicit states
- hidden states
- transition tables
- duplicated lifecycle encoding
- refactor hotspots

### 4.2 Test matrix

`docs/architecture/state-machine-test-matrix.md`

This document turns the transition inventory into a test contract covering:

- entity transitions
- invariants
- coordination scenarios

### 4.3 Event/effect model

`docs/architecture/state-machine-reducer-event-model.md`

This defines:

- shared reducer event envelope
- shared effect envelope
- reducer ownership boundaries
- event vocabulary
- coordinator rules

## 5. Implemented extraction status

At the time of this document, the following extractions are complete.

### 5.1 Task reducer extraction

Implemented:

- `src/task-reducer.ts`
- `test/task-reducer.test.ts`
- integration through `src/task-store.ts`

Preserved semantics include:

- monotonic ids
- completion timestamps
- reopen semantics
- prune semantics

### 5.2 Loop reducer extraction

Implemented:

- `src/loop-reducer.ts`
- `test/loop-reducer.test.ts`
- integration through `src/store.ts`

Reducer-owned logical transitions now cover:

- create
- pause
- resume
- fire count increments
- delete
- expiry deletion
- backlog-empty deletion

### 5.3 Notification reducer extraction

Implemented:

- `src/notification-reducer.ts`
- `test/notification-reducer.test.ts`
- integration through `src/index.ts`

Reducer-owned logical behavior now covers:

- queueing
- recurring dedupe
- flush gating
- clearing
- delivery selection

The effect layer still owns actual Pi delivery via `pi.sendMessage()`.

### 5.4 Monitor reducer extraction

Implemented:

- `src/monitor-reducer.ts`
- `test/monitor-reducer.test.ts`
- integration through `src/monitor-manager.ts`

Reducer-owned logical behavior now covers:

- create
- output accumulation
- complete
- error
- stop
- prune
- onDone registration marker

### 5.5 Coordinator module

Implemented:

- `src/coordinator.ts`
- `test/coordinator.test.ts`

The coordinator currently exists as a reusable module with:

- ordered reducer fan-out
- ordered effect execution
- derived event dispatch
- depth limiting

It is not yet fully wired through the main runtime.

## 6. Current architecture after extraction

The codebase now sits in an intermediate but useful state.

### 6.1 What is already improved

- entity state transitions are increasingly centralized in pure reducers
- transition semantics are backed by focused reducer tests
- scenario coverage exists for the highest-risk lifecycle behavior

### 6.2 What remains transitional

The runtime still contains a hybrid structure.

For example:

- `src/index.ts` still coordinates many behaviors directly
- stores and managers invoke reducers, but not yet through a single event coordinator path
- reducer effects are mostly informative today rather than universally executed through the coordinator

This is acceptable as a migration phase, but it is not the final architecture.

### 6.3 Default scope decision

The recommended default remains `PI_LOOP_SCOPE=session`.

Reasoning:

- `session` preserves useful intent across a session restart without leaking loops/tasks across concurrent sessions or worktrees
- `memory` is safer for disposable experiments, but too lossy as a default for long-running loop/task workflows
- `project` is appropriate only when shared automation is explicitly desired, because it intentionally exposes persisted state across sessions in the same repo

This recommendation also fits the current wake model:

- pending notifications stay in memory and remain cancelable
- durable loop/task intent stays isolated per session
- stale event wakes are already treated as harmless and cleaned up defensively

---

## 7. Recommended final target architecture

The recommended end state is:

1. runtime adapters gather facts and external inputs
2. coordinator converts them into reducer events
3. reducers return next state plus effects
4. coordinator executes effects in deterministic order
5. runtime wrappers own only imperative side effects

### 7.1 Runtime adapters

Examples:

- tool handlers
- scheduler callbacks
- monitor process callbacks
- Pi session lifecycle hooks

### 7.2 Reducers

Reducers own logical state transitions for:

- tasks
- loops
- notifications
- monitors

### 7.3 Coordinator

The coordinator should become the single place where cross-entity rules are expressed as named dispatch flows.

### 7.4 Effect executors

Effect executors should perform:

- persistence writes
- runtime arming/disarming
- wake delivery
- pruning and cleanup requests

This gives the system a clear separation between meaning and mechanism.

---

## 8. Recommended adoption sequence from here

The safest rollout sequence is incremental.

### Step 1 — keep current reducer-backed wrappers stable

Do not remove the current `TaskStore`, `LoopStore`, `MonitorManager`, or notification helpers yet.

Instead, continue using them as adapter layers around reducer logic.

### Step 2 — introduce coordinator wiring in narrow slices

The first coordinator adoption should focus on one contained path at a time.

Suggested order:

1. notification queue/flush path inside `src/index.ts`
2. loop fire -> notification dispatch path
3. task backlog threshold / empty-queue coordination path
4. monitor completion -> wake path

### Step 3 — move effect execution behind coordinator handlers

As each slice moves over, imperative code should become effect execution rather than state mutation.

### Step 5 — remove redundant imperative state paths

Only after coordinator-owned dispatch is proven stable should old duplicated state paths be deleted.

---

## 9. Risks and sharp edges

Several risks remain even after the current extraction work.

### 9.1 Dual paths during migration

During transition, some state moves through reducers while orchestration remains imperative.

Risk:

- duplicated semantics
- logic drift between wrappers and coordinator adoption

Mitigation:

- keep reducer tests authoritative
- convert one path at a time
- avoid broad rewrites

### 9.2 Notification delivery is still timing-sensitive

Notification logic is much clearer now, but actual delivery still depends on runtime conditions such as:

- agent activity
- pending message state
- delivery-time task counts

Mitigation:

- preserve scenario tests
- move flush triggering into coordinator slices carefully

### 9.3 Monitor runtime is still inherently imperative

Child processes, signals, and close/error ordering remain imperative concerns even after reducer extraction.

Mitigation:

- keep runtime handle ownership in `MonitorManager`
- only reduce logical state
- preserve stop/completion race tests

## 10. Validation strategy

The migration should continue to rely on three validation layers.

### 10.1 Reducer unit tests

These verify pure transition correctness.

### 10.2 Existing integration/scenario tests

These ensure runtime semantics remain stable while adapters are refactored.

### 10.3 Full repo validation

Continue using:

- `npm run lint`
- `npm run typecheck`
- `npm run test`
- `git diff --check`

for every migration step.

---

## 11. What this migration has achieved

The most important result is not merely new code. It is a new constraint on future code.

We now have:

- a transition inventory
- a test contract
- reducer modules for the four existing entity families
- a coordinator abstraction

This means future work can be judged against a coherent architecture instead of a collection of local fixes.

---

## 12. Summary

The migration has moved `pi-loop` from a runtime whose correctness depended heavily on imperative control flow toward one whose semantics are increasingly explicit, reducer-owned, and test-backed.

The system is not yet at the final architecture. However, it now has the essential ingredients needed to finish the transition safely:

- named events
- reducer state boundaries
- effect boundaries
- coordinator machinery

The recommended next step, if further work continues, is to adopt the coordinator in narrow runtime slices rather than attempt a single large integration rewrite.