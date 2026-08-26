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

The initial state must be non-terminal. Each wake presents the current state, state instructions, the active workflow execution (subject + lease owner/expiry), allowed outcomes, and — after the first transition — the last transition and its recorded evidence, so the next state can act on what the previous one found. The agent finishes the state by selecting one declared outcome:

```text
WorkflowTransition id="1" outcome="root_cause_found" evidence="A null config reaches the parser."
WorkflowTransition id="1" outcome="tests_pass" evidence="Targeted and full test suites pass."
```

`WorkflowTransition` validates the branch, settles the current execution, records evidence, and activates the next state's execution in the same locked write. Newly entered task phases start unowned so another agent sharing project scope can claim the next phase immediately; whichever agent continues must call `WorkflowClaim id="1"` first. Workflow work is embedded in the loop controller — never call `TaskClaim` or `TaskUpdate` for it. `WorkflowClaim` also renews the current runtime's lease or takes over an expired lease after a restart. A self-loop creates a fresh unowned attempt execution and increments the displayed attempt count. When a target reaches `maxAttempts`, only outcomes leading to that target become unavailable; other declared outcomes remain selectable. Reaching a `completed` terminal state deletes the workflow loop; reaching a `paused` terminal state preserves it in paused state for inspection or deletion. Terminal workflow states cannot be resumed. Task status does not guess an outcome—the model selects one explicitly. LoopList and workflow wakes omit outcomes whose target state has exhausted `maxAttempts`.

When active work discovers a missing prerequisite or supersedes future instructions, inspect `LoopList` and submit one typed revision against its exact definition revision, state, and transition sequence:

```text
WorkflowRevise id="1" expectedRevision=1 expectedState="investigate" expectedTransitionSeq=0 reason="A compatibility check is required before implementation" changes='[
  {"op":"add_state","stateId":"validate_compatibility","state":{"prompt":"Validate compatibility.","task":{"subject":"Validate compatibility","description":"Run compatibility checks."},"on":{"validated":"fix"}}},
  {"op":"redirect_transition","from":"investigate","outcome":"root_cause_found","expectedTo":"fix","to":"validate_compatibility"},
  {"op":"revise_state","stateId":"fix","prompt":"Implement the compatible fix."}
]'
```

`WorkflowRevise` stores the prior definition, reason, accepted changes, timestamp, and runtime actor as immutable history. It preserves current execution and lease state, changes only future work or current outgoing edges, and rejects stale revisions or transitions. It never creates standalone tasks. See the [reference](./REFERENCE.md#adaptive-revision) for operation and graph rules.

To repeat a state until evidence supports an outcome, add a cron-only state policy: `"loop":{"schedule":"0 7 * * *","maxFires":10,"startImmediately":false}`. Only the active state's policy is armed. Scheduled wakes retain the active execution; `WorkflowTransition` remains the only operation that settles it and unlocks the destination execution and cadence. `maxFires` is local to that state and pauses the workflow when exhausted. State policies do not wake immediately unless `startImmediately` is `true`.

`LoopList` includes workflow state, active execution, transition evidence, and valid outcomes alongside ordinary loops.

### Inspecting and stopping loops

```text
LoopList
LoopDelete id="1" action="pause"
LoopDelete id="1" action="delete"
```

`LoopDelete` defaults to `action="delete"` and removes the controller and its embedded executions.

## Async subagent orchestration

`OrchestrationCreate` runs a finite batch of independent work after the parent turn becomes idle:

```text
OrchestrationCreate goal="Review release readiness" work='[
  {"prompt":"Inspect API compatibility","agentType":"Explore"},
  {"prompt":"Review rollout risks","agentType":"Plan"}
]' concurrency=2 maxAttempts=2 maxTurns=12
```

This surface requires the default file-backed session scope and `@tintinweb/pi-subagents` protocol v2. It rejects memory/project scope, `PI_LOOP=off`, and custom `PI_LOOP` paths. The batch is stored only in `LoopStore`; it does not create standalone tasks or delegate workflow states.

Work items must be independent. The controller does not model dependencies or protect overlapping filesystem writes. Each spawned worker is background, does not inherit parent context, and is isolated from extension tools, so it cannot call pi-loop task/workflow/controller tools. The optional `agentType`, `model`, and `maxTurns` fields are the only invocation overrides.

Local `concurrency` bounds spawning/queued/running dispatches while pi-subagents keeps its own global concurrency ceiling. A proved worker failure retries up to `maxAttempts`. A spawn RPC timeout becomes `uncertain` and requires parent review because upstream has no status/list query or idempotent dispatch key.

Inspect compact progress with `LoopList` and durable evidence with:

```text
OrchestrationGet id="1"
OrchestrationGet id="1" workId="2"
```

The parent is not woken merely to refill capacity. It wakes once when all work completes, attempts are exhausted, or a dispatch becomes uncertain. Results are persisted before the consume RPC. Completed and attention batches pause for inspection; `LoopUpdate` cannot mutate them. `LoopDelete` first fences cancellation, best-effort stops known workers, then pauses or deletes the controller.

Session shutdown/switch stops owned workers before rebinding storage. Confirmed stops remain retryable within their attempt budget; unconfirmed workers become uncertain. A crashed runtime cannot safely reconstruct an upstream worker, so ownership-expiry recovery fails closed instead of redispatching it.

## Background monitors

`MonitorCreate` runs a shell command without blocking the agent:

```text
MonitorCreate command="npm test" description="Run test suite" onDone="Inspect the result and fix failures"
```

Output is buffered and emitted as `monitor:output`. A monitor finishes as one of:

- clean exit: emits `monitor:done`
- nonzero exit or spawn failure: emits `monitor:error`
- inactivity timeout: stops the process after no output or structured progress, emits `monitor:error`, and always wakes the agent after the process reaps
- explicit `MonitorStop`: cancels the monitor without an `onDone` wake; workflow-owned monitors resume their current state with `status=stopped`

Pass `onDone` whenever the agent should resume work after success or failure. Its one-shot wake also fires on timeout; monitors without `onDone` still send a timeout-only alert. `timeout` is an inactivity threshold, not a total-runtime limit: stdout/stderr bytes, JSONL progress, and `MonitorUpdate` renew it. The default is five quiet minutes; use `timeout=0` to disable stale detection.

For a monitor launched from an active workflow, use `workflowId` instead of `onDone`:

```text
MonitorCreate command="npm test" description="Validate release" workflowId="29"
```

The workflow pauses its cadence while the monitor runs. While the same Pi runtime remains active, success, failure, timeout, or explicit `MonitorStop` resumes the same state once with status, stop reason, exit code, and output count; inspect the result and call `WorkflowTransition` with a declared outcome. Do not poll with `LoopUpdate` while it waits.

A session shutdown or switch interrupts the monitor: its in-memory process and wait are discarded without a terminal workflow wake. In session or project scope, inspect the resumed workflow and start a new monitor if the work still needs to run; memory-scoped workflows are discarded.

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
TaskGet id="1"
TaskClaim id="1" leaseSeconds=1800
TaskHeartbeat id="1" claimId="<claim-id>" leaseSeconds=1800
TaskUpdate id="1" status="completed" claimId="<claim-id>"
TaskUpdate id="1" status="closed" claimId="<claim-id>"  # abandon without completion
TaskDelete id="1"
```

The native provider is selected for the session and exposes `/tasks`, compact status-line tracking, persisted task state, lifecycle events, and task RPC replies. `TaskClaim` provides one live owner per task, renewable heartbeats, and takeover only after lease expiry. It also moves the task to `in_progress`; a following `TaskUpdate status="in_progress"` is harmless but redundant. Claimed terminal updates require the exact live claim token; an expired token must be replaced by reclaiming the task. `closed` is terminal like `completed`, is excluded from pending backlog work, and deliberately does not emit `tasks:completed`; use it when work is intentionally abandoned.

See the [reference](./REFERENCE.md#mutation-guarantees) for ownership and mutation boundaries.

TaskList shows each standalone task with a short description excerpt. TaskGet reads its full untruncated description, timestamps, claim state, and metadata. Workflow state work is stored only in `LoopStore` and appears through `LoopList`, never through TaskList or TaskGet.

Set `taskBacklog=true` on a recurring `tasks:created` event loop to process unfinished standalone tasks. Creating tasks alone does not start autonomous work.

Each wake is action-first: call `TaskList`, inspect `TaskGet`, claim or resume one task, perform concrete work, run observable validation, and settle it in the same turn. Status prose and future-tense promises are not progress. Empty backlogs and verified live-owner blockers are the only no-work exits.

Workers bootstrap existing work, coalesce repeated create events, resume eligible `in_progress` tasks before unrelated pending work, and delete themselves when the queue drains. They pause visibly at the default 25-fire cap. Prerequisites are a description convention (for example, “depends on #2”), not first-class TaskStore edges; use `TaskGet` to follow them. `autoTask` is separate and creates a new task on each ordinary loop fire.

## Events

Monitor events:

- `monitor:output`
- `monitor:done`
- `monitor:error`

Native task lifecycle events:

- `tasks:created`
- `tasks:started`
- `tasks:completed`
- `tasks:closed`
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

The TUI status line summarizes active loops, monitors, and native tasks. Use `LoopList`, `MonitorList`, and `/tasks` for detail. `LoopList` reports active-loop `age` as wall-clock time since creation, including pause and process downtime; paused loops omit the field. The status clears when no work is active.

The runtime allows at most 25 active loops and 25 running monitors.
