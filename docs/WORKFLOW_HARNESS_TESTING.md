# Workflow harness testing

Workflow reliability is validated at three layers. Reducer tests prove state-machine invariants, runtime integration tests prove linked task ownership across real extension wiring, and an opt-in live Pi RPC harness checks whether an LLM follows the workflow prompt and tools end to end.

## Linked task contract

A workflow state task represents one state attempt.

- `WorkflowTransition` exclusively settles the linked task.
- `TaskUpdate status="completed"|"closed"` rejects workflow-owned tasks.
- A declared self-loop is an explicit retry. It increments `transitionSeq` and `attemptsByState`, completes the prior attempt task, and creates a new task whose workflow link carries the new sequence.
- `maxAttempts` bounds state re-entry.
- A legacy state task that is already terminal may be reconciled by an explicit `WorkflowTransition`; task status never selects the outcome.
- Terminal workflow completion removes the controller only after its final linked task is settled.

When a state has a cron loop policy, repeated scheduled fires belong to the same state attempt: the linked task remains active, and only `WorkflowTransition` settles it. Tests must verify that only the active state policy is armed, its local fire count persists, and its local fire cap pauses the controller.

The wake message and `LoopList` summary expose `Attempt: current/max`, the active task ID, allowed outcomes, and the rule that linked tasks must not be terminally updated through `TaskUpdate`.

## Deterministic tests

```bash
npm test -- --run \
  test/workflow-reducer.test.ts \
  test/loop-tools.test.ts \
  test/workflow-task-integration.test.ts \
  test/injection.test.ts
```

`test/workflow-task-integration.test.ts` exercises the actual extension registration and native task fallback:

1. create a workflow and sequence-0 linked task;
2. claim the task;
3. verify direct close is rejected;
4. transition through a `work -> work` retry;
5. verify attempt 2, transition sequence 1, and a fresh sequence-1 task;
6. claim and transition to the terminal state;
7. verify both tasks are completed and no workflow controller is orphaned;
8. verify an already-closed legacy task can still transition explicitly.

Property tests independently verify transition sequence and attempt-count invariants:

```bash
npm run test:property
```

## Prompt conformance evaluation

The workflow wake/task guidance was evaluated with fresh clean-slate executors using fixed critical checklists.

| Iteration | Scenarios | Result | Accuracy | New ambiguity |
|---|---:|---|---:|---|
| Baseline | first attempt, second attempt, rejected-close recovery | failure | 80%, 80%, 87.5% | executors confused `claimId` with the removed `activeTaskId` field |
| Revision | first attempt, rejected-close recovery | success | 100%, 100% | none |
| Holdout | attempt 3/3 with retry exhausted | success | 100% | none |
| Embedded execution | retry self-loop, terminal completion, restart claim | success | 100%, 100%, 100% | none |

The minimal revision names the exact `WorkflowTransition` fields in both wake and tool guidance, explicitly says that `activeTaskId` is invalid, and lists only outcomes whose target attempt limits remain available. The holdout executor correctly claimed the linked task and chose `done` instead of the exhausted `retry` self-loop.

The embedded-execution revision removed the external task link entirely: wake guidance names the active workflow execution and its lease instead of a task, `WorkflowTransition` accepts only `id`/`outcome`/`evidence`, and the live harness asserts zero `TaskClaim`/`TaskUpdate` calls and an empty TaskStore.

This evaluation complements deterministic tests: it measures whether an unbiased executor understands the prompt, while the integration suite proves that the resulting tool sequence preserves state.

## Live Pi RPC harness

The live test is opt-in because it uses a configured model. It starts a real `pi --mode rpc` subprocess with only the built extension enabled, waits for native task fallback registration, and asks the model to drive a two-attempt self-loop workflow.

```bash
PI_LOOP_LIVE_MODEL="openai-codex/gpt-5.6-sol:minimal" npm run test:e2e:workflow
```

Optional controls:

```bash
PI_LOOP_LIVE_TIMEOUT_MS=240000 \
PI_LOOP_LIVE_ARTIFACT_DIR=.artifacts/live-workflow-custom \
PI_LOOP_LIVE_MODEL="<provider/model[:thinking]>" \
  npm run test:e2e:workflow
```

Without `PI_LOOP_LIVE_MODEL`, the harness exits successfully with `SKIP`. The run uses an isolated temporary working directory and `PI_LOOP_SCOPE=project`; it does not touch the repository's persisted loops or tasks.

The harness fails unless all of these hold:

- exactly one `WorkflowCreate`;
- exactly two `TaskClaim` calls;
- transitions occur as `retry`, then `done`;
- no terminal `TaskUpdate` is attempted for linked tasks;
- the workflow loop is deleted at terminal completion;
- exactly two linked tasks remain, both completed;
- task workflow sequence links are `0`, then `1`.

A bounded report is written to `.artifacts/live-workflow/latest.json`, including tool calls, final isolated state, the last 500 RPC events, and bounded stderr. Credentials and environment values are not recorded.

Run both live E2E surfaces with:

```bash
npm run test:e2e
```

The older reminder test may skip when its local llama endpoint is unavailable; the linked-workflow test independently skips when no live model is explicitly selected.
