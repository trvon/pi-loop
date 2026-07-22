# pi-loop usage guide

`pi-loop` re-wakes a pi agent from schedules and events, runs self-paced goal loops, and monitors background commands. This guide covers the operational details; see the [README](../README.md) for installation and a quick start.

## Loops

### Scheduled loops

Use `/loop <interval> <prompt>` or `LoopCreate`:

```text
/loop 5m check the deploy
LoopCreate trigger="0 9 * * 1-5" prompt="Review weekday alerts" maxFires=10
```

Intervals such as `5m`, `2h`, and `1d` are converted to cron expressions. Full five-field cron expressions are also accepted. Cron and hybrid loops track their next fire time and deliver only when the agent is idle.

Use `maxFires` for polling or other bounded work so a loop cannot run indefinitely. Recurring loops expire after seven days.

### Event loops

Event loops react to pi events instead of polling:

```text
/loop event tasks:created process the backlog
LoopCreate trigger="tool_execution_end" prompt="Review the completed tool call" triggerType="event" recurring=true
```

`LoopCreate` event loops are one-shot by default. Set `recurring=true` to keep listening. Prefer events when a relevant source exists; use hybrid triggers when an event needs a scheduled safety net.

### Hybrid loops

A hybrid trigger combines cron and event delivery with a debounce window:

```text
LoopCreate trigger="cron:5m event:tasks:created" prompt="Process pending tasks" triggerType="hybrid" debounceMs=30000
```

### Dynamic goal loops

Free text passed to `/loop` creates a self-paced dynamic goal:

```text
/loop finish the release
```

The first wake is immediate when the agent is idle. After each iteration, the agent calls `LoopUpdate`:

```text
LoopUpdate id="1" status="continue" state="Tests pass; reviewing package"
LoopUpdate id="1" status="continue" nextInterval="3m"
LoopUpdate id="1" status="paused" state="Waiting for credentials"
LoopUpdate id="1" status="completed"
```

- `continue` saves progress and wakes again when idle.
- `continue` with `nextInterval` schedules a timed wake.
- `paused` preserves progress without firing.
- `completed` finishes and deletes the loop.

Paused dynamic loops can be resumed from the `/loop` menu. If an in-memory wake is lost during a restart or session switch, persisted dynamic state recovers it.

### Opt-in workflow loops

Use a workflow only when work has stable named phases and outcomes. Ordinary reminders, polling, event hooks, and flat task backlogs should continue to use `LoopCreate` or the task tools.

```text
WorkflowCreate goal="Fix the regression" definition='{
  "version": 1,
  "initialState": "investigate",
  "states": {
    "investigate": {
      "prompt": "Find and verify the root cause.",
      "task": { "subject": "Investigate regression", "description": "Find the root cause and reproduce it." },
      "on": { "root_cause_found": "fix", "blocked": "blocked" }
    },
    "fix": {
      "prompt": "Implement and validate the fix.",
      "task": { "subject": "Implement fix", "description": "Make the smallest fix and run targeted validation." },
      "on": { "tests_pass": "done", "regression_found": "investigate" },
      "maxAttempts": 2
    },
    "done": { "prompt": "Report completion.", "terminal": "completed" },
    "blocked": { "prompt": "Report the blocker.", "terminal": "paused" }
  }
}'
```

Each wake presents the current state, state instructions, active task, and allowed outcomes. The agent finishes the state by selecting one declared outcome:

```text
WorkflowTransition id="1" outcome="root_cause_found" evidence="A null config reaches the parser."
WorkflowTransition id="1" outcome="tests_pass" evidence="Targeted and full test suites pass."
```

`WorkflowTransition` validates the branch, records evidence, creates the next state's optional task, and queues the next wake. Reaching a `completed` terminal state deletes the workflow loop; reaching a `paused` terminal state preserves it in paused state. Task completion does not guess an outcome—the model selects one explicitly.

```text
WorkflowList
```

Lists only workflow loops, including their active state, active task, and valid outcomes.

### Inspecting and stopping loops

```text
LoopList
LoopDelete id="1" action="pause"
LoopDelete id="1" action="delete"
```

`LoopDelete` defaults to `action="delete"`.

## Background monitors

`MonitorCreate` runs a shell command without blocking the agent:

```text
MonitorCreate command="npm test" description="Run test suite" onDone="Inspect the result and fix failures"
```

Output is buffered and emitted as `monitor:output`. A monitor finishes as one of:

- clean exit: emits `monitor:done`
- nonzero exit or spawn failure: emits `monitor:error`
- timeout: stops the process, emits `monitor:error`, and reports the timeout
- explicit `MonitorStop`: cancels the monitor without an `onDone` wake

Pass `onDone` whenever the agent should resume work after completion. Its one-shot wake fires on success, failure, or timeout. The default timeout is five minutes; use `timeout=0` to disable it.

```text
MonitorList
MonitorStop monitorId="1"
```

`MonitorList` includes status, exit code when available, output count, and the last five buffered lines. Finished monitors remain briefly available before pruning.

## Task integration

### With pi-tasks

When [@tintinweb/pi-tasks](https://github.com/tintinweb/pi-tasks) is available, `pi-loop` uses it over the task RPC channels. Set `autoTask=true` on `LoopCreate` to create a tracked task for each fire.

### Native fallback

If `pi-tasks` does not answer during startup detection, `pi-loop` registers:

```text
TaskCreate subject="Fix deploy polling" description="Replace polling with an event-driven loop"
TaskList
TaskUpdate id="1" status="in_progress"
TaskUpdate id="1" status="completed"
TaskDelete id="1"
```

The native provider is selected for the session and exposes `/tasks`, compact status-line tracking, persisted task state, lifecycle events, and task RPC replies.

Set `taskBacklog=true` on a loop that processes existing pending tasks. Backlog workers bootstrap when tasks already exist and delete themselves when the queue drains. `autoTask` serves a different purpose: it creates a new task on each loop fire.

## Events

Monitor events:

- `monitor:output`
- `monitor:done`
- `monitor:error`

Native task lifecycle events:

- `tasks:created`
- `tasks:started`
- `tasks:completed`
- `tasks:reopened`
- `tasks:updated`
- `tasks:deleted`
- `tasks:backlog_empty`
- `loops:autodeleted`

Task event payloads include `previousStatus`. Transition events report the status before the transition; details-only `tasks:updated` events report the status current at edit time.

## Cross-extension task RPC

External consumers should import only from `@trevonistrevon/pi-loop/api`; deep `src/` imports are blocked by the package export map.

```ts
import { TASKS_RPC, rpcCall } from "@trevonistrevon/pi-loop/api";

const { id, task } = await rpcCall(pi.events, TASKS_RPC.create, {
  subject: "Fix deploy polling",
  description: "Replace polling with an event-driven loop",
});
```

`rpcCall` rejects on failure or timeout. The native provider supports:

| Channel | Request | Reply |
|---|---|---|
| `tasks:rpc:ping` | `{}` | `{ version, provider }` |
| `tasks:rpc:pending` | `{}` | `{ pending }` |
| `tasks:rpc:create` | `{ subject, description, metadata? }` | `{ id, task }` |
| `tasks:rpc:clean` | `{}` | `{ pruned }` |
| `tasks:rpc:update` | `{ id, status?, subject?, description? }` | `{ task }` |

Requests include `requestId`; replies arrive on `<channel>:reply:<requestId>` as `{ success: true, data }` or `{ success: false, error }`.

## Persistence and configuration

| Variable | Effect | Default |
|---|---|---|
| `PI_LOOP` | Store path override; use `off` to disable persistence | derived from scope |
| `PI_LOOP_SCOPE` | `memory`, `session`, or `project` | `session` |
| `PI_LOOP_DEBUG` | Debug logging to stderr | unset |

Scope behavior:

- `session`: persists loops and tasks per session ID while isolating concurrent sessions and worktrees
- `memory`: keeps all state ephemeral
- `project`: shares persisted automation across sessions in the repository

Session files live under `.pi/loops/` and `.pi/tasks/`. Keep `session` as the normal default; use `project` only when shared automation is intentional.

## Status line and limits

The TUI status line summarizes active loops, monitors, and native tasks. Use `LoopList`, `MonitorList`, and `/tasks` for detail. The status clears when no work is active.

The runtime allows at most 25 active loops and 25 running monitors.
