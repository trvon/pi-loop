# pi-loop State and Transition Inventory

## Scope

This document inventories the current explicit and implicit state for:

- native tasks
- loops
- monitors
- pending notifications / wake delivery
- cross-entity coordination paths

It is the baseline for the planned reducer/state-machine refactor.

## 1. Native task state

### Explicit task states

Defined in `src/task-types.ts`:

- `pending`
- `in_progress`
- `completed`

### Persisted task fields

Defined in `TaskEntry`:

- `id`
- `subject`
- `description`
- `status`
- `createdAt`
- `updatedAt`
- `completedAt?`
- `metadata?`

### Persisted task container state

Defined in `TaskStore`:

- `nextId`
- `tasks: Map<string, TaskEntry>`
- optional `filePath` / `lockPath`

### Task transitions

| From | Event | To | Notes |
|---|---|---|---|
| none | `TaskCreate` / `/tasks` quick-create / autoTask fallback create | `pending` | increments monotonic `nextId` |
| `pending` | `TaskUpdate(status=in_progress)` / interactive `> Start` | `in_progress` | active work starts |
| `pending` | `TaskUpdate(status=completed)` / interactive `ok Complete` | `completed` | `completedAt` set |
| `in_progress` | `TaskUpdate(status=completed)` / interactive `ok Complete` | `completed` | `completedAt` set |
| `in_progress` | `TaskUpdate(status=pending)` / interactive `* Return to pending` | `pending` | re-queued |
| `completed` | `TaskUpdate(status=pending)` / interactive `* Reopen` | `pending` | currently clears state semantically, but leaves `completedAt` populated |
| any existing | `TaskDelete` / interactive delete | deleted | removed from store |
| `completed` | `cleanDoneTasks()` / `sweepCompleted()` | pruned | removed from store, `nextId` preserved |

### Hidden / implicit task state

These are not encoded as task status values, but materially affect behavior:

- task provider mode: `tasksAvailable` vs `nativeTaskStore`
- storage scope: `memory` / `session` / `project`
- backlog summary state derived in widget: `count`, `active`, `next`
- completed-task retention policy is event-driven, not time-driven
- `completedAt` remains populated if a completed task is reopened

### Task sharp edges

- `completed` and `pruned` are separate lifecycle phases but only one is explicit.
- Reopening a completed task does not clear `completedAt`; this is harmless now but muddies semantics.
- Provider mode (`pi-tasks` vs native fallback) is global session state, not entity state.
- Cleanup policy is distributed across commit hooks, loop zero-pending paths, and explicit delete/sweep flows.

## 2. Loop state

### Explicit loop states

Defined in `src/types.ts`:

- `active`
- `paused`

### Persisted loop fields

Defined in `LoopEntry`:

- `id`
- `prompt`
- `trigger`
- `status`
- `recurring`
- `createdAt`
- `updatedAt`
- `expiresAt`
- `autoTask?`
- `taskBacklog?`
- `readOnly?`
- `maxFires?`
- `fireCount?`

### Trigger variants

- `cron`
- `event`
- `hybrid`

### Loop transitions

| From | Event | To | Notes |
|---|---|---|---|
| none | `LoopCreate` / auto worker creation / monitor onDone helper | `active` | persisted in store |
| `active` | `LoopDelete(action=pause)` / interactive pause | `paused` | subscriptions/timers removed |
| `paused` | `LoopDelete(action=resume)` / interactive resume | `active` | subscriptions/timers re-added |
| `active` | `LoopDelete(delete)` / interactive delete | deleted | removed from store and trigger system |
| `active` | `onLoopFire` with recurring loop | `active` | `fireCount++`; may queue wake |
| `active` | `onLoopFire` and `maxFires` reached | deleted | removed immediately |
| `active` | one-shot event or one-shot monitor completion loop fired | deleted | trigger system removes after fire |
| `active` | `cleanupTaskBacklogLoops()` and zero pending tasks | deleted | only for `taskBacklog` or auto worker loop |
| `active` | `clearExpired()` / expiry boundary | deleted | recurring lifetime cap |
| `active` | `expireEventLoops()` on resumed session | deleted | old event/hybrid loops from prior session pruned |

### Hidden / implicit loop state

These states are currently distributed across multiple structures:

- scheduler armed/not-armed: `CronScheduler.fireTimes`
- event subscribed/not-subscribed: `TriggerSystem.eventSubscriptions`
- hybrid debounce timer pending/not-pending: `TriggerSystem.hybridTimers`
- last fire timestamp for debounce: `TriggerSystem.lastFireTime`
- wake queued/not-queued: `pendingNotifications`
- wake dedupe keying: recurring loops use `loop:<id>`, one-shot uses `loop:<id>:<timestamp>`
- worker-loop classification is partly semantic (`prompt` string match) and partly structural (`taskBacklog`) 
- bootstrapped-against-backlog is an effect, not persisted state

### Loop sharp edges

- `active` covers multiple sub-states: armed, waiting, queued, delivering, debounced.
- Auto worker loop detection still depends partly on prompt equality (`AUTO_TASK_WORKER_PROMPT`).
- Task backlog semantics are split between `taskBacklog`, `tasks:created` trigger shape, and prompt heuristics.
- Monitor `onDone` loops are stored as generic loops, but delivered by a separate direct completion path.

## 3. Monitor state

### Explicit monitor states

Defined in `src/types.ts`:

- `running`
- `completed`
- `error`
- `stopped`

### Persisted/in-memory monitor fields

Defined in `MonitorEntry` / `MonitorProcess`:

- `id`
- `command`
- `description?`
- `timeout`
- `status`
- `startedAt`
- `completedAt?`
- `exitCode?`
- `outputLines`
- `outputBuffer`
- `pid`
- `proc`
- `abortController`
- `waiters`
- `completionCallbacks`

### Monitor transitions

| From | Event | To | Notes |
|---|---|---|---|
| none | `MonitorCreate` | `running` | child process spawned |
| `running` | child `close` exit code 0 | `completed` | emits `monitor:done` and direct completion callbacks |
| `running` | child `close` nonzero | `error` | emits `monitor:error` |
| `running` | child `error` | `error` | emits `monitor:error` |
| `running` | `MonitorStop` | `stopped` | SIGTERM then SIGKILL fallback |
| `completed/error` | 30s retention timeout | pruned | removed from `processes` map |

### Hidden / implicit monitor state

- completion callbacks registered/not-registered for `onDone`
- monitor retained-for-UI vs logically finished
- event-based completion signaling and direct callback signaling both exist
- process liveness is split between child process reality and `entry.status`

### Monitor sharp edges

- Completion has two signaling channels: event bus and direct callback.
- `stopped` bypasses the `finish()` helper and therefore differs from `completed/error` paths.
- Retention window is time-based but only in memory; no persisted monitor store exists.

## 4. Pending notification / wake delivery state

This is the largest implicit state area today.

### Structures

- `agentRunning: boolean`
- `_latestCtx?.hasPendingMessages()`
- `pendingNotifications: Map<string, PendingNotification>`
- `flushPromise?: Promise<void>`

### Wake pipeline states

These are not explicit enum values today, but they exist behaviorally:

- generated (`buildLoopFireMessage`)
- queued (`pendingNotifications.set(...)`)
- deduped/replaced (same recurring loop key)
- blocked by active agent
- blocked by pending messages
- delivered via `pi.sendMessage(..., { deliverAs: "steer", triggerTurn: true })`
- dropped due to zero pending tasks at delivery time
- cleared on `session_shutdown` / `session_switch`

### Notification transitions

| From | Event | To | Notes |
|---|---|---|---|
| none | `onLoopFire` / monitor completion / backlog bootstrap | generated | message built |
| generated | `queueOrDeliverNotification` | queued | stored in map |
| queued | `flushPendingNotifications` while idle | delivered | sends custom message |
| queued recurring | newer fire same key | replaced | latest prompt wins |
| queued | delivery-time pending tasks == 0 and `autoTask` true | dropped | triggers completed-task cleanup |
| queued | `session_shutdown` / `session_switch` | cleared | dropped without delivery |

### Hidden / implicit notification state

- one-shot vs recurring dedupe is encoded in key generation
- delivery eligibility is a conjunction of agent idle + pending-message policy + autoTask pending count
- some wake sources are event-driven, some direct-callback driven

## 5. Cross-entity coordination state

These are coordination rules that span multiple entities and should likely become explicit reducer events.

### Existing coordination rules

1. **Task backlog threshold -> auto worker loop creation**
   - when native pending count reaches `>= 5`
   - creates a hybrid task-backlog loop

2. **Zero pending tasks -> backlog loop deletion**
   - backlog worker loops are deleted when pending count reaches `0`

3. **Successful git commit -> completed task pruning**
   - `tool_execution_end` for successful `bash` `git commit` calls `cleanDoneTasks()`

4. **Monitor completion -> onDone wake**
   - direct callback path for `MonitorCreate(..., onDone)`
   - generic event path remains for manual `LoopCreate trigger='monitor:done'`

5. **Session lifecycle -> store/scheduler/reset behavior**
   - `turn_start`, `before_agent_start`, `agent_start`, `agent_end`, `session_switch`, `session_shutdown`

### Hidden coordinator state

- whether `pi-tasks` is available is global mutable session state
- whether native task tools are registered is global mutable session state
- current session id affects storage paths but is not part of entity state
- worker loop ownership is inferred rather than strongly modeled

## 6. Duplicate / overlapping state encodings

### Loop status is spread across four places

A loop's real status is currently determined by all of:

- `LoopEntry.status`
- `CronScheduler.fireTimes`
- `TriggerSystem.eventSubscriptions`
- `pendingNotifications`

A loop can be `active` in the store while simultaneously:

- not armed in scheduler
- unsubscribed from events
- queued for delivery
- already logically terminal but not yet deleted

### Monitor completion is dual-path

Completion signaling uses both:

- `monitor:done` / `monitor:error` events
- `completionCallbacks`

This is correct for reliability today, but it means state transitions are duplicated conceptually.

### Task completion and pruning are separate lifecycles

Task lifecycle currently has at least:

- active work state (`pending` / `in_progress`)
- finished state (`completed`)
- retention state (still listed vs swept)

Only the first two are explicit.

## 7. Suggested normalization targets for the reducer refactor

### Task machine

Recommended explicit states:

- `pending`
- `in_progress`
- `completed_retained`
- `pruned` (terminal/effect boundary, may remain implicit in storage)

Recommended explicit events:

- `TASK_CREATED`
- `TASK_STARTED`
- `TASK_COMPLETED`
- `TASK_REOPENED`
- `TASK_DELETED`
- `TASKS_PRUNED`

### Loop machine

Recommended explicit states:

- `active_idle`
- `active_debounced`
- `queued_for_delivery`
- `paused`
- `completed_terminal`
- `deleted`

Recommended explicit events:

- `LOOP_CREATED`
- `LOOP_ARMED`
- `LOOP_FIRED`
- `LOOP_QUEUED`
- `LOOP_DELIVERED`
- `LOOP_PAUSED`
- `LOOP_RESUMED`
- `LOOP_DELETED`
- `LOOP_EXPIRED`
- `LOOP_MAX_FIRES_REACHED`

### Monitor machine

Recommended explicit states:

- `running`
- `completed_retained`
- `error_retained`
- `stopped_retained`
- `pruned`

Recommended explicit events:

- `MONITOR_CREATED`
- `MONITOR_OUTPUT`
- `MONITOR_COMPLETED`
- `MONITOR_ERRORED`
- `MONITOR_STOPPED`
- `MONITOR_PRUNED`
- `MONITOR_ONDONE_REGISTERED`

### Notification machine

Recommended explicit states:

- `queued`
- `blocked_by_agent`
- `blocked_by_pending_messages`
- `ready_to_deliver`
- `delivered`
- `dropped`
- `cleared`

Recommended explicit events:

- `NOTIFICATION_QUEUED`
- `NOTIFICATION_REPLACED`
- `NOTIFICATION_DELIVERED`
- `NOTIFICATION_DROPPED`
- `NOTIFICATION_CLEARED`

## 8. Refactor hotspots

These are the highest-value places to extract into reducer-driven logic:

1. `src/index.ts`
   - pending notification logic
   - task backlog loop creation/cleanup
   - commit-driven completed-task pruning
   - session lifecycle hooks

2. `src/trigger-system.ts`
   - event subscription vs fire vs terminal deletion

3. `src/scheduler.ts`
   - active/armed/expired/maxFires scheduling transitions

4. `src/monitor-manager.ts`
   - unify retained terminal states and completion effect dispatch

5. `src/task-store.ts` + native task tool handlers
   - completion retention vs pruning policy

## 9. Minimum next test matrix enabled by this inventory

The next test pass should assert:

- a loop cannot remain `active` after terminal deletion conditions
- a monitor `onDone` wake is delivered exactly once
- a task backlog loop with zero pending tasks is eventually deleted
- completed tasks can be pruned without resetting `nextId`
- recurring wake dedupe preserves only the latest queued prompt
- session switch clears pending notifications but preserves the intended persisted entities

## 10. Summary

Current behavior works, but state is encoded across:

- persisted entity fields
- scheduler maps
- event subscription maps
- callback arrays
- booleans
- pending wake queues
- provider-mode globals

The reducer/state-machine refactor should make these lifecycle phases explicit, move hidden coordination state into named transitions, and separate pure transition logic from effect execution.