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

- persistent store at `.pi/tasks/tasks.json`
- `TaskCreate`, `TaskList`, `TaskUpdate`, `TaskDelete`
- `/tasks` interactive viewer
- compact widget task tracking

This fallback is session-sticky: `pi-loop` decides once at startup whether `pi-tasks` or native tasks own task management for that session.

## Widget

`pi-loop` keeps a compact persistent TUI widget above the editor.

It now shows a single focus-friendly status line such as:

```text
none
1 loop · 1 monitor
2 tasks | active: Fix deploy polling
1 loop · 2 monitors · 3 tasks | next: Update README
```

Only task counts and the single active/next task are shown in the widget so attention stays on what is currently happening. Use `LoopList`, `MonitorList`, and `/tasks` for detail.

## Configuration

| Variable | Effect | Default |
|---|---|---|
| `PI_LOOP` | Store path. `off` to disable, absolute or project-relative path | `.pi/loops/loops.json` |
| `PI_LOOP_SCOPE` | `memory` (ephemeral), `session` (per-session file), `project` (shared) | `session` |
| `PI_LOOP_DEBUG` | Debug logging to stderr | unset |

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
