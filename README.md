<p align="center">
<h1 align="center">@trevonistrevon/pi-loop</h1>
<h6 align="center">Durable agent loops, workflows, tasks, subagent orchestration, and background monitoring for Pi.</h6>
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

Run work in the background and wake the agent when it succeeds, fails, or becomes inactive:

```text
MonitorCreate command="python train.py" onDone="Analyze results and report best loss"
MonitorList
MonitorStop monitorId="1"
```

Run a finite batch of independent subagent work after the parent becomes idle:

```text
OrchestrationCreate goal="Review release readiness" work='[{"prompt":"Inspect API compatibility","agentType":"Explore"},{"prompt":"Review rollout risks","agentType":"Plan"}]' concurrency=2
OrchestrationGet id="1"
```

## What it provides

- Cron, event, hybrid, dynamic goal, and opt-in workflow loops
- Idle-safe agent re-wakes with dynamic-loop restart/session-switch recovery
- Background command monitoring with buffered output, `onDone` wakes, and renewable inactivity alerts
- Optional `pi-tasks` integration and a native task fallback
- Session-scoped, bounded async subagent orchestration through protocol-v2 `pi-subagents`
- Session-isolated persistence and a compact TUI status line

> **Research note:** These features are designed to benefit my research. The loop may drive this tool toward unexpected design choices, so treat those choices as experimental and review them before relying on them.

## Commands and tools

| Surface | Purpose |
|---|---|
| `/loop` | Create or manage scheduled, event, and dynamic goal loops |
| `/tasks` | Manage native fallback tasks when `pi-tasks` is absent |
| `LoopCreate`, `LoopList`, `LoopUpdate`, `LoopDelete` | Create and control ordinary loops |
| `WorkflowCreate`, `WorkflowClaim`, `WorkflowRevise`, `WorkflowTransition` | Create, claim, revise, and advance workflows; paused terminals require trusted blocker admission |
| `OrchestrationCreate`, `OrchestrationGet` | Run and inspect a finite batch of independent async subagent work; cancel with `LoopDelete` |
| `MonitorCreate`, `MonitorList`, `MonitorStop` | Run and inspect background commands |
| `TaskCreate`, `TaskList`, `TaskClaim`, `TaskHeartbeat`, `TaskUpdate`, `TaskDelete` | Native fallback task management |

Choose one owner: workflows for one goal with ordered phases/outcomes/rework/handoff, standalone tasks for independently completable backlog items, and dynamic loops for a self-paced goal without phase routing. Persist unfinished task/loop progress or workflow plan changes in that owner, then continue while work remains actionable.

See the [usage guide](./docs/USAGE_GUIDE.md) for operator workflows and the [reference](./docs/REFERENCE.md) for authority, persistence, mutation, RPC, and recovery boundaries.

## Development

```bash
npm run typecheck
npm run lint
npm test
npm run build
# Opt-in real Pi/LLM workflow conformance
PI_LOOP_LIVE_MODEL="<provider/model[:thinking]>" npm run test:e2e:workflow
```

See [testing](./docs/TESTING.md) for local, property, package, benchmark, and live E2E gates. Contributors and agents must also follow [AGENTS.md](./AGENTS.md).

## License

MIT — [LICENSE](./LICENSE)
