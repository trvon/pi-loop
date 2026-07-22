<p align="center">
<h1 align="center">@trevonistrevon/pi-loop</h1>
<h6 align="center">Scheduled and event-driven agent re-wakes for pi, with dynamic goals and background process monitoring.</h6>
</p>

## Install

```bash
pi install npm:@trevonistrevon/pi-loop
```

## Quick start

Create scheduled, event-driven, or self-paced loops:

```text
/loop 5m check the deploy
/loop event tasks:created process the backlog
/loop finish the release
```

Or use the tools directly:

```text
LoopCreate trigger="5m" prompt="Check if the build passed" maxFires=12
LoopCreate trigger="tool_execution_start" prompt="Log the tool" triggerType="event" recurring=true
LoopList
LoopDelete id="1"
```

Run work in the background and wake the agent when it succeeds, fails, or times out:

```text
MonitorCreate command="python train.py" onDone="Analyze results and report best loss"
MonitorList
MonitorStop monitorId="1"
```

## What it provides

- Cron, event, hybrid, dynamic goal, and opt-in workflow loops
- Idle-safe agent re-wakes with dynamic-loop restart/session-switch recovery
- Background command monitoring with buffered output and `onDone` wakes
- Optional `pi-tasks` integration and a native task fallback
- Session-isolated persistence and a compact TUI status line

## Commands and tools

| Surface | Purpose |
|---|---|
| `/loop` | Create or manage scheduled, event, and dynamic goal loops |
| `/tasks` | Manage native fallback tasks when `pi-tasks` is absent |
| `LoopCreate`, `LoopList`, `LoopUpdate`, `LoopDelete` | Create and control ordinary loops |
| `WorkflowCreate`, `WorkflowList`, `WorkflowTransition` | Create and advance opt-in task-driven workflows |
| `MonitorCreate`, `MonitorList`, `MonitorStop` | Run and inspect background commands |
| `TaskCreate`, `TaskList`, `TaskUpdate`, `TaskDelete` | Native fallback task management |

See the [usage guide](./docs/USAGE_GUIDE.md) for trigger types, dynamic loop lifecycle, monitor behavior, task integration, configuration, events, and the public RPC API.

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
