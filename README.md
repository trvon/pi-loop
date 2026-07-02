<p align="center">
<h1 align="center">@trevonistrevon/pi-loop</h1>
<h6 align="center">Cron and event loops for the pi coding agent. Background monitors, scheduled re-wakes, pi-tasks integration, and native task fallback.</h6>
</p>

## Install

```bash
pi install npm:@trevonistrevon/pi-loop
```

## Quick start

```text
LoopCreate trigger="5m" prompt="Check if the build passed"
LoopCreate trigger="tool_execution_start" prompt="Log the tool being used" triggerType="event"
LoopList
LoopDelete id="1"
```

```text
MonitorCreate command="tail -n0 -f build.log" description="Watch build"
MonitorCreate command="python train.py" onDone="Analyze results and report best loss"
MonitorList
MonitorStop monitorId="1"
```

When `pi-tasks` is not installed, `pi-loop` also exposes native task tools after startup detection:

```text
TaskCreate subject="Fix deploy polling" description="Switch deploy check to event-driven loop"
TaskList
TaskUpdate id="1" status="in_progress"
TaskDelete id="1"
```

## Commands

`/loop [interval] [prompt]` — interactive loop creation.

```text
/loop                         # menu
/loop 5m check the deploy     # 5-minute cron loop
```

`/tasks` — interactive native task viewer/manager, only registered when `pi-tasks` is absent.

```text
/tasks                        # open native task viewer
/tasks Write README updates   # quick-create native task
```

## Tools

| Tool | What it does |
|---|---|
| `LoopCreate` | Schedule a prompt on a cron timer, a pi event, or both with debounce |
| `LoopList` | Show active loops with IDs, triggers, and next-fire times |
| `LoopDelete` | Delete or pause a loop |
| `MonitorCreate` | Run a background command, stream output as `monitor:output` events. Use `onDone` for auto-notify on completion |
| `MonitorList` | Show monitors with status, uptime, and output line count |
| `MonitorStop` | Stop a monitor (SIGTERM → 5s → SIGKILL) |
| `TaskCreate` | Create a native fallback task when `pi-tasks` is absent |
| `TaskList` | List native fallback tasks |
| `TaskUpdate` | Update native fallback task status/details |
| `TaskDelete` | Delete a native fallback task |

Trigger types: `cron` (`5m`, `1h`, `0 9 * * 1-5`), `event` (any pi event source), or `hybrid` (both, debounced).

## Tasks

### With `pi-tasks`

Works with [@tintinweb/pi-tasks](https://github.com/tintinweb/pi-tasks). Pass `autoTask: true` on `LoopCreate` and each loop fire auto-creates a tracked task. Detection happens over pi's event bus — no manual wiring.

### Without `pi-tasks`

If `pi-tasks` does not respond during startup detection, `pi-loop` registers a native fallback task system for the session:

- session- or project-scoped task files under `.pi/tasks/` depending on `PI_LOOP_SCOPE`
- `TaskCreate`, `TaskList`, `TaskUpdate`, `TaskDelete`
- `/tasks` interactive viewer
- compact status-line task tracking
- native task RPC replies on `tasks:rpc:ping`, `tasks:rpc:create`, `tasks:rpc:pending`, `tasks:rpc:clean`, and `tasks:rpc:update`

This fallback is session-sticky: `pi-loop` decides once at startup whether `pi-tasks` or native tasks own task management for that session.

### Task and backlog events

`pi-loop` emits native task lifecycle events that other extensions can consume directly:

- `tasks:created`
- `tasks:started`
- `tasks:completed`
- `tasks:reopened`
- `tasks:updated`
- `tasks:deleted`

Payloads carry `previousStatus`. Transition events (`tasks:started` /
`tasks:completed` / `tasks:reopened`) report the status before the transition;
`tasks:updated` (a details edit) reports the status current at edit time — so a
combined status+details update never fabricates a second transition. (Changed
in 0.6.0: the tool path previously reused the pre-transition status.)
- `tasks:backlog_empty` — emitted when a task-backlog worker observes zero pending tasks and is about to auto-delete
- `loops:autodeleted` — emitted for each loop that `pi-loop` auto-deletes, including backlog workers removed because the task queue drained

### Cross-extension task RPC

Other extensions can create and manage native tasks without importing `pi-loop` internals. `pi-loop` answers `ping` over `pi.events` from extension init; the other verbs unlock once the pi-tasks detection probe settles (a few seconds at most, immediate when no provider replies race it). The whole server stands down (silent no-op) once an external `pi-tasks` is detected:

| Channel | Request | Reply |
|---|---|---|
| `tasks:rpc:ping` | `{}` | `{ version, provider }` |
| `tasks:rpc:pending` | `{}` | `{ pending }` |
| `tasks:rpc:create` | `{ subject, description, metadata? }` | `{ id, task }` |
| `tasks:rpc:clean` | `{}` | `{ pruned }` |
| `tasks:rpc:update` | `{ id, status?, subject?, description? }` | `{ task }` |

Every request/reply pair follows the same contract: emit `{ requestId, ...params }` on the channel, receive an envelope on `<channel>:reply:<requestId>` — `{ success: true, data }` or `{ success: false, error }`.

`@trevonistrevon/pi-loop/api` exports typed channel constants and a client helper so consumers don't hand-roll the envelope:

```ts
import { TASKS_RPC, rpcCall } from "@trevonistrevon/pi-loop/api";

const { id, task } = await rpcCall(pi.events, TASKS_RPC.create, {
  subject: "Fix deploy polling",
  description: "Switch deploy check to event-driven loop",
});
```

`rpcCall` rejects on failure or timeout instead of returning a sentinel; wrap it in `try/catch` if you want fallback behavior. Import only from `@trevonistrevon/pi-loop/api` — the package's `exports` map blocks deep `src/` imports.

## Status line

`pi-loop` keeps a compact persistent status line in the TUI.

When active work exists, it shows a single focus-friendly line such as:

```text
1 loop · 1 monitor
2 tasks | active: Fix deploy polling
1 loop · 2 monitors · 3 tasks | next: Update README
```

When no loops, monitors, or native tasks are active, the status line clears completely.

Only task counts and the single active/next task are shown there so attention stays on what is currently happening. Use `LoopList`, `MonitorList`, and `/tasks` for detail.

## Configuration

| Variable | Effect | Default |
|---|---|---|
| `PI_LOOP` | Store path override. `off` to disable, absolute or project-relative path | unset → derived from `PI_LOOP_SCOPE` |
| `PI_LOOP_SCOPE` | `memory` (ephemeral), `session` (per-session file), `project` (shared) | `session` |
| `PI_LOOP_DEBUG` | Debug logging to stderr | unset |

In `session` scope (default), loop and task files are saved per session ID (e.g. `.pi/loops/loops-<sessionId>.json` and `.pi/tasks/tasks-<sessionId>.json`) so concurrent sessions and worktree agents do not share state. In `memory` scope nothing persists to disk.

### Recommended scope policy

Keep `PI_LOOP_SCOPE=session` as the default.

- `session` is the best balance for normal use: it preserves loops/tasks across a session restart while isolating concurrent sessions and worktrees.
- `memory` is best for disposable scratch work, tests, or situations where you explicitly do not want any persisted loop/task state.
- `project` should be opt-in for intentionally shared automation, because it allows multiple sessions in the same repo to see the same persisted state.



## Limits

25 active loops, 25 running monitors. Recurring loops expire after 7 days.

## Development

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT — [LICENSE](./LICENSE)
