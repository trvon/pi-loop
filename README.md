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
LoopCreate trigger="tasks:created" prompt="Process unfinished tasks" triggerType="event" recurring=true taskBacklog=true maxFires=25
LoopList
LoopDelete id="1"
```

`/loop event tasks:created ...` is treated as an explicit task-backlog worker: it adopts existing unfinished tasks, coalesces task-creation bursts, and re-wakes after each agent turn until the backlog drains. Tool callers opt into the same behavior with `taskBacklog=true`. Worker wakes are action-first: `TaskList`, claim/resume, concrete same-turn work, validation, then evidence—not a state report or promise to start on a later wake.

Run work in the background and wake the agent when it succeeds, fails, or times out:

```text
MonitorCreate command="python train.py" onDone="Analyze results and report best loss"
MonitorList
MonitorStop monitorId="1"
```

## What it provides

- Cron, event, hybrid, dynamic goal, and opt-in workflow loops
- Idle-safe agent re-wakes with dynamic-loop restart/session-switch recovery
- Background command monitoring with buffered output, `onDone` wakes, and timeout alerts
- Optional `pi-tasks` integration and a native task fallback
- Session-isolated persistence and a compact TUI status line

## Commands and tools

| Surface | Purpose |
|---|---|
| `/loop` | Create or manage scheduled, event, and dynamic goal loops |
| `/tasks` | Manage native fallback tasks when `pi-tasks` is absent |
| `LoopCreate`, `LoopList`, `LoopUpdate`, `LoopDelete` | Create and control ordinary loops |
| `WorkflowCreate`, `WorkflowTransition` | Create and advance opt-in task-driven workflows; inspect them with `LoopList` |
| `MonitorCreate`, `MonitorList`, `MonitorStop` | Run and inspect background commands |
| `TaskCreate`, `TaskList`, `TaskClaim`, `TaskHeartbeat`, `TaskUpdate`, `TaskDelete` | Native fallback task management |

See the [usage guide](./docs/USAGE_GUIDE.md) for trigger types, dynamic loop lifecycle, monitor behavior, task integration, configuration, events, and the public RPC API. The [mutation contract](./docs/architecture/mutation-contract.md) defines accepted, idempotent, and rejected task/loop/workflow writes.

## Development

```bash
npm run typecheck
npm run lint
npm test
npm run build
# Opt-in real Pi/LLM workflow conformance
PI_LOOP_LIVE_MODEL="<provider/model[:thinking]>" npm run test:e2e:workflow
```

See [CONTRIBUTING.md](./CONTRIBUTING.md), the [security policy](./.github/SECURITY.md), the [workflow harness testing guide](./docs/WORKFLOW_HARNESS_TESTING.md), the [task-backlog prompt testing guide](./docs/BACKLOG_PROMPT_TESTING.md), and the [profiling and fuzzing guide](./docs/PROFILING_AND_FUZZING.md).

## License

MIT — [LICENSE](./LICENSE)
