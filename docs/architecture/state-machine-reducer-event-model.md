# pi-loop Reducer Event Model

## Purpose

This document defines the reducer-facing event model for the planned state-machine extraction.

It sits between:

- `docs/architecture/state-machine-transition-map.md`
- `docs/architecture/state-machine-test-matrix.md`

Its job is to give tasks `#6` and `#7` a stable contract for:

- event names
- reducer inputs
- reducer outputs
- side-effect descriptions
- entity ownership boundaries

This is a design artifact only. It does **not** change runtime behavior yet.

---

## 1. Design goals

The event model should:

1. preserve current semantics before simplifying implementation
2. keep reducers pure
3. separate **state transitions** from **effects**
4. avoid one giant FSM for everything
5. make cross-entity coordination explicit
6. support future Goal orchestration without rewriting the core model again

---

## 2. Model shape

Use **separate reducers per entity family** plus a thin coordinator.

### Reducers

- `reduceTaskState(...)`
- `reduceLoopState(...)`
- `reduceMonitorState(...)`
- `reduceNotificationState(...)`
- later: `reduceGoalState(...)`

### Coordinator

A small coordinator should:

- receive runtime events
- fan them out to the relevant reducer(s)
- collect emitted effects
- execute those effects in order
- emit any derived follow-up events

This keeps:

- reducers deterministic
- side effects testable as data
- cross-entity logic explicit instead of buried in `src/index.ts`

---

## 3. Shared event envelope

All reducer events should use one envelope shape.

```ts
interface ReducerEvent<TType extends string = string, TPayload = unknown> {
  type: TType;
  at: number;
  source:
    | "tool"
    | "command"
    | "scheduler"
    | "eventbus"
    | "monitor"
    | "session"
    | "coordinator"
    | "system";
  entityType?: "task" | "loop" | "monitor" | "notification";
  entityId?: string;
  payload: TPayload;
}
```

### Rules

- `type` is the stable contract
- `at` is required for ordering and deterministic tests
- `source` records where the event originated
- `entityType` and `entityId` are optional because some events are global
- `payload` must be serializable test data

---

## 4. Shared effect envelope

Reducers do not call Pi APIs directly. They emit effects.

```ts
interface ReducerEffect<TEffect extends string = string, TPayload = unknown> {
  type: TEffect;
  entityType?: "task" | "loop" | "monitor" | "notification";
  entityId?: string;
  payload: TPayload;
}
```

### Effect classes

1. **persistence effects**
   - save/delete/update store entries
2. **runtime wiring effects**
   - add/remove scheduler entries
   - add/remove event subscriptions
3. **wake/message effects**
   - queue notification
   - flush notification
   - clear notifications
4. **cleanup effects**
   - prune tasks
   - prune monitors
   - delete stale loops
5. **derived-event effects**
   - request that the coordinator dispatch another reducer event

---

## 5. State ownership boundaries

### Task reducer owns

- task entities
- task status transitions
- monotonic task ids
- completed-task retention vs prune state

### Loop reducer owns

- loop entities
- active/paused/terminal lifecycle
- fire counts
- maxFires/expiry decisions
- backlog-loop classification

### Monitor reducer owns

- monitor entities
- running/completed/error/stopped lifecycle
- terminal retention/prune status
- completion callback registration state

### Notification reducer owns

- queued notifications
- dedupe behavior
- flush eligibility state
- cleared/dropped/delivered outcomes

### Coordinator owns

- event ordering across reducers
- derived-event dispatch
- effect execution
- fan-out rules like "monitor completed -> queue wake"
- runtime API integration with Pi/tool layer

---

## 6. Event vocabulary

The event set should be small but explicit.

### 6.1 Task events

```ts
type TaskEventType =
  | "TASK_CREATED"
  | "TASK_STARTED"
  | "TASK_COMPLETED"
  | "TASK_REOPENED"
  | "TASK_UPDATED"
  | "TASK_DELETED"
  | "TASKS_PRUNED";
```

### Semantics

- `TASK_CREATED`: create a new pending task
- `TASK_STARTED`: transition pending -> in_progress
- `TASK_COMPLETED`: transition pending|in_progress -> completed
- `TASK_REOPENED`: transition completed -> pending
- `TASK_UPDATED`: subject/description-only edits or generic fallback
- `TASK_DELETED`: remove one task
- `TASKS_PRUNED`: remove all completed tasks by policy trigger

### Recommended payloads

```ts
type TaskCreatedPayload = {
  id: string;
  subject: string;
  description: string;
  metadata?: Record<string, unknown>;
};

type TaskStatePayload = { id: string };

type TaskUpdatedPayload = {
  id: string;
  subject?: string;
  description?: string;
};

type TasksPrunedPayload = {
  reason: "git_commit" | "zero_pending_cleanup" | "manual";
};
```

---

### 6.2 Loop events

```ts
type LoopEventType =
  | "LOOP_CREATED"
  | "LOOP_PAUSED"
  | "LOOP_RESUMED"
  | "LOOP_DELETED"
  | "LOOP_FIRED"
  | "LOOP_MAX_FIRES_REACHED"
  | "LOOP_EXPIRED"
  | "LOOP_BACKLOG_EMPTY"
  | "LOOP_BOOTSTRAP_REQUESTED"
  | "LOOP_ARMING_RECONCILE_REQUESTED";
```

### Semantics

- `LOOP_CREATED`: a new loop exists in active state
- `LOOP_PAUSED`: active -> paused
- `LOOP_RESUMED`: paused -> active
- `LOOP_DELETED`: terminal removal by user/system
- `LOOP_FIRED`: one due fire occurred
- `LOOP_MAX_FIRES_REACHED`: final fire consumed limit
- `LOOP_EXPIRED`: lifetime cap or stale-session expiry
- `LOOP_BACKLOG_EMPTY`: taskBacklog loop should self-delete
- `LOOP_BOOTSTRAP_REQUESTED`: existing backlog should create initial wake
- `LOOP_ARMING_RECONCILE_REQUESTED`: sync loop state with scheduler/subscriptions

### Recommended payloads

```ts
type LoopCreatedPayload = {
  id: string;
  prompt: string;
  trigger: unknown;
  recurring: boolean;
  autoTask?: boolean;
  taskBacklog?: boolean;
  readOnly?: boolean;
  maxFires?: number;
};

type LoopIdPayload = { id: string };

type LoopFiredPayload = {
  id: string;
  trigger: unknown;
  recurring: boolean;
  autoTask?: boolean;
  readOnly?: boolean;
};

type LoopExpiredPayload = {
  id: string;
  reason: "expires_at" | "resume_event_stale" | "already_completed_monitor";
};
```

---

### 6.3 Monitor events

```ts
type MonitorEventType =
  | "MONITOR_CREATED"
  | "MONITOR_OUTPUT"
  | "MONITOR_COMPLETED"
  | "MONITOR_ERRORED"
  | "MONITOR_STOPPED"
  | "MONITOR_PRUNED"
  | "MONITOR_ONDONE_REGISTERED";
```

### Semantics

- `MONITOR_CREATED`: running monitor started
- `MONITOR_OUTPUT`: output line buffered/emitted
- `MONITOR_COMPLETED`: clean exit
- `MONITOR_ERRORED`: process error or nonzero exit
- `MONITOR_STOPPED`: explicit stop path
- `MONITOR_PRUNED`: retention timeout elapsed
- `MONITOR_ONDONE_REGISTERED`: completion callback attached

### Recommended payloads

```ts
type MonitorCreatedPayload = {
  id: string;
  command: string;
  description?: string;
  timeout: number;
};

type MonitorOutputPayload = {
  id: string;
  line: string;
};

type MonitorCompletedPayload = {
  id: string;
  exitCode?: number;
  outputLines: number;
};

type MonitorErroredPayload = {
  id: string;
  exitCode?: number;
  error?: string;
  outputLines?: number;
};

type MonitorStoppedPayload = {
  id: string;
  reason: "manual" | "timeout";
};

type MonitorOnDoneRegisteredPayload = {
  id: string;
  prompt: string;
  loopId?: string;
};
```

---

### 6.4 Notification events

```ts
type NotificationEventType =
  | "NOTIFICATION_QUEUED"
  | "NOTIFICATION_REPLACED"
  | "NOTIFICATION_DELIVERED"
  | "NOTIFICATION_DROPPED"
  | "NOTIFICATION_CLEARED"
  | "NOTIFICATION_FLUSH_REQUESTED";
```

### Semantics

- `NOTIFICATION_QUEUED`: add pending wake
- `NOTIFICATION_REPLACED`: recurring dedupe replaced earlier wake
- `NOTIFICATION_DELIVERED`: sent to Pi successfully
- `NOTIFICATION_DROPPED`: removed without delivery by policy
- `NOTIFICATION_CLEARED`: removed due to session change/shutdown
- `NOTIFICATION_FLUSH_REQUESTED`: coordinator should attempt delivery pass

### Recommended payloads

```ts
type NotificationQueuedPayload = {
  key: string;
  loopId: string;
  message: string;
  recurring?: boolean;
  autoTask?: boolean;
  readOnly?: boolean;
  trigger: unknown;
};

type NotificationDroppedPayload = {
  key: string;
  reason:
    | "zero_pending_tasks"
    | "session_switch"
    | "session_shutdown"
    | "superseded";
};

type NotificationClearedPayload = {
  reason: "session_switch" | "session_shutdown";
};
```

---

### 6.5 Session / coordinator events

These are not owned by one entity reducer, but they drive coordination.

```ts
type CoordinatorEventType =
  | "SESSION_TURN_STARTED"
  | "SESSION_BEFORE_AGENT_START"
  | "SESSION_AGENT_STARTED"
  | "SESSION_AGENT_ENDED"
  | "SESSION_SWITCHED"
  | "SESSION_SHUTDOWN"
  | "TASK_BACKLOG_THRESHOLD_REACHED"
  | "TASK_BACKLOG_EMPTIED"
  | "TASK_PROVIDER_DETECTED"
  | "TASK_PROVIDER_UNAVAILABLE"
  | "GIT_COMMIT_SUCCEEDED";
```

### Notes

- session events should usually emit **derived entity events** rather than mutate entity state directly
- `GIT_COMMIT_SUCCEEDED` should derive `TASKS_PRUNED`
- `TASK_BACKLOG_THRESHOLD_REACHED` should derive `LOOP_CREATED` for the worker loop if absent
- `TASK_BACKLOG_EMPTIED` should derive `LOOP_BACKLOG_EMPTY`

---

## 7. Reducer outputs

Each reducer should return both next state and effects.

```ts
interface ReduceResult<TState> {
  state: TState;
  effects: ReducerEffect[];
}
```

### Rule

A reducer may emit effects, but it may **not**:

- call Pi APIs
- read system time directly
- mutate unrelated reducer state
- inspect external runtime maps directly

All external facts must arrive as events.

---

## 8. Effect vocabulary

Use a small, explicit effect set.

### 8.1 Persistence effects

```ts
type PersistenceEffectType =
  | "PERSIST_TASK"
  | "DELETE_TASK"
  | "PERSIST_LOOP"
  | "DELETE_LOOP"
  | "PERSIST_MONITOR"
  | "DELETE_MONITOR";
```

### 8.2 Runtime wiring effects

```ts
type RuntimeEffectType =
  | "ARM_LOOP_RUNTIME"
  | "DISARM_LOOP_RUNTIME"
  | "REGISTER_MONITOR_ONDONE"
  | "SCHEDULE_MONITOR_PRUNE";
```

### 8.3 Notification effects

```ts
type NotificationEffectType =
  | "QUEUE_NOTIFICATION"
  | "DELIVER_NOTIFICATION"
  | "CLEAR_NOTIFICATIONS"
  | "REQUEST_NOTIFICATION_FLUSH";
```

### 8.4 Derived-event effects

```ts
type DerivedEventEffectType = "DISPATCH_EVENT";
```

### 8.5 Cleanup effects

```ts
type CleanupEffectType =
  | "PRUNE_COMPLETED_TASKS"
  | "PRUNE_TERMINAL_MONITORS"
  | "RECONCILE_BACKLOG_LOOPS";
```

---

## 9. Event-to-current-runtime mapping

This section maps today's code paths to the future event model.

### Current: `TaskCreate`

Emit:

- `TASK_CREATED`
- maybe `TASK_BACKLOG_THRESHOLD_REACHED`

### Current: `TaskUpdate(status=in_progress)`

Emit:

- `TASK_STARTED`

### Current: `TaskUpdate(status=completed)`

Emit:

- `TASK_COMPLETED`
- maybe `TASK_BACKLOG_EMPTIED`

### Current: `TaskUpdate(status=pending)` on completed task

Emit:

- `TASK_REOPENED`

### Current: `LoopCreate`

Emit:

- `LOOP_CREATED`
- maybe `LOOP_BOOTSTRAP_REQUESTED`
- `LOOP_ARMING_RECONCILE_REQUESTED`

### Current: `LoopDelete(action=pause)`

Emit:

- `LOOP_PAUSED`

### Current: resume action from interactive UI

Emit:

- `LOOP_RESUMED`
- `LOOP_ARMING_RECONCILE_REQUESTED`

### Current: scheduler/event trigger fire

Emit:

- `LOOP_FIRED`
- maybe `LOOP_MAX_FIRES_REACHED`
- derived `NOTIFICATION_QUEUED`

### Current: monitor start

Emit:

- `MONITOR_CREATED`
- maybe `MONITOR_ONDONE_REGISTERED`

### Current: monitor clean exit

Emit:

- `MONITOR_COMPLETED`
- derived `NOTIFICATION_QUEUED` for onDone path
- derived `MONITOR_PRUNED` after retention timeout

### Current: monitor error path

Emit:

- `MONITOR_ERRORED`

### Current: monitor stop

Emit:

- `MONITOR_STOPPED`

### Current: `session_switch`

Emit:

- `SESSION_SWITCHED`
- derived `NOTIFICATION_CLEARED`
- maybe derived `LOOP_EXPIRED` for stale event/hybrid loops
- maybe derived `LOOP_DELETED` for memory-scope non-resume clearing

### Current: `session_shutdown`

Emit:

- `SESSION_SHUTDOWN`
- derived `NOTIFICATION_CLEARED`

### Current: successful `git commit`

Emit:

- `GIT_COMMIT_SUCCEEDED`
- derived `TASKS_PRUNED`

---

## 10. Coordinator rules

These rules should move out of ad hoc control flow into explicit coordinator logic.

### Rule A — backlog threshold auto-worker creation

When native pending tasks cross the threshold:

1. dispatch `TASK_BACKLOG_THRESHOLD_REACHED`
2. if no worker loop exists, emit `LOOP_CREATED`
3. emit `LOOP_BOOTSTRAP_REQUESTED` if backlog already exists

### Rule B — backlog empties

When pending tasks reach zero:

1. dispatch `TASK_BACKLOG_EMPTIED`
2. derive `LOOP_BACKLOG_EMPTY` for each `taskBacklog` loop
3. reducer emits `DELETE_LOOP`

### Rule C — loop fire -> notification

When `LOOP_FIRED` occurs:

1. loop reducer increments `fireCount`
2. if limit reached, also derive `LOOP_MAX_FIRES_REACHED`
3. coordinator requests notification queueing
4. notification reducer decides replace vs append

### Rule D — notification flush

When idle/session conditions allow:

1. dispatch `NOTIFICATION_FLUSH_REQUESTED`
2. notification reducer chooses next deliverable item
3. emit `DELIVER_NOTIFICATION`
4. if delivery blocked, keep state unchanged

### Rule E — monitor onDone

When a monitor with onDone completes:

1. dispatch `MONITOR_COMPLETED`
2. derive `NOTIFICATION_QUEUED` directly
3. do **not** depend on generic eventbus delivery semantics for correctness

### Rule F — session switch/shutdown

1. dispatch session event
2. clear pending notifications
3. derive any loop cleanup events required by scope/resume rules
4. reconcile runtime wiring afterward

---

## 11. Reducer state shapes

These should stay small and explicit.

### Task reducer state

```ts
interface TaskReducerState {
  tasksById: Record<string, TaskEntryView>;
  nextId: number;
}
```

### Loop reducer state

```ts
interface LoopReducerState {
  loopsById: Record<string, LoopEntryView>;
}
```

### Monitor reducer state

```ts
interface MonitorReducerState {
  monitorsById: Record<string, MonitorEntryView>;
}
```

### Notification reducer state

```ts
interface NotificationReducerState {
  notificationsByKey: Record<string, PendingNotificationView>;
  agentRunning: boolean;
  hasPendingMessages: boolean;
}
```

### Important

Runtime-only objects like:

- child process handles
- scheduler timer internals
- event unsubscribe functions
- abort controllers

should remain **outside** reducer state. Reducers track only their logical status.

---

## 12. Recommended migration order

### Step 1 — task reducer

Extract first because it is the simplest and already well covered.

Start with:

- `TASK_CREATED`
- `TASK_STARTED`
- `TASK_COMPLETED`
- `TASK_REOPENED`
- `TASK_DELETED`
- `TASKS_PRUNED`

### Step 2 — loop reducer

Extract next, but keep runtime arming/disarming as effects.

Start with:

- `LOOP_CREATED`
- `LOOP_PAUSED`
- `LOOP_RESUMED`
- `LOOP_DELETED`
- `LOOP_FIRED`
- `LOOP_MAX_FIRES_REACHED`
- `LOOP_EXPIRED`
- `LOOP_BACKLOG_EMPTY`

### Step 3 — notification reducer

Then extract queue/dedupe/flush rules.

Start with:

- `NOTIFICATION_QUEUED`
- `NOTIFICATION_REPLACED`
- `NOTIFICATION_DROPPED`
- `NOTIFICATION_CLEARED`
- `NOTIFICATION_FLUSH_REQUESTED`

### Step 4 — monitor reducer

Finally extract monitor lifecycle because it has the most runtime coupling.

Start with:

- `MONITOR_CREATED`
- `MONITOR_COMPLETED`
- `MONITOR_ERRORED`
- `MONITOR_STOPPED`
- `MONITOR_PRUNED`
- `MONITOR_ONDONE_REGISTERED`

---

## 13. Test alignment

Every event in this model should map cleanly to the existing matrix.

### Examples

- matrix `T-03` -> `TASK_STARTED`
- matrix `T-06` -> `TASK_REOPENED`
- matrix `L-08` -> `LOOP_FIRED` then `LOOP_DELETED`
- matrix `M-09` -> `MONITOR_COMPLETED` then derived `NOTIFICATION_QUEUED`
- matrix `N-08` -> `SESSION_SWITCHED` then derived `NOTIFICATION_CLEARED`
- matrix `S-08` -> `MONITOR_COMPLETED` while `agentRunning=true`, then `SESSION_AGENT_ENDED`, then `NOTIFICATION_DELIVERED`

If an event cannot be tied to a transition/invariant/scenario row, it is probably too vague or too implementation-specific.

---

## 14. Non-goals

This event model does **not** yet define:

- Goal reducer fields
- UI rendering model
- task provider abstraction replacement
- a generalized event sourcing log

It only defines the reducer contract needed to extract the current runtime safely.

---

## 15. Summary

The recommended architecture is:

- separate reducers per entity family
- one shared event envelope
- one shared effect envelope
- thin coordinator for cross-entity rules
- runtime integration only in effect execution

That gives tasks `#6` and `#7` a concrete target while preserving the current semantics locked down by the new tests.