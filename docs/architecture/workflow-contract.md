# Opt-in workflow contract

Workflow loops are a controller layer over dynamic loops and tasks. They are not the default model for schedules, events, or task backlogs.

## Ownership

- A `LoopEntry.workflow` owns the workflow definition and the persisted run state.
- A task may carry a `TaskWorkflowLink` identifying the owning loop, state, and transition sequence.
- Task status remains independent from workflow state. A linked state task never infers an outcome.
- `WorkflowTransition` owns terminal settlement of the linked state task. Direct `TaskUpdate completed|closed` calls are rejected so the workflow cannot retain a terminal active-task link.
- The model selects an outcome through `WorkflowTransition`; the runtime validates and persists it. A self-loop is an explicit retry: it increments `transitionSeq` and `attemptsByState`, settles the prior task, and creates a new task linked to the new transition sequence.

## Definition

`WorkflowDefinition` version 1 contains an `initialState` and named states. A state has a prompt, optional `task`, outcome map `on`, optional positive `maxAttempts`, optional cron-only `loop` policy (`schedule`, optional positive `maxFires`, optional `startImmediately`), or a terminal status of `completed` or `paused`.

Every declared outcome must target a named state. Terminal states may not declare outcomes or loop policies. A state may be entered at most `maxAttempts` times when that limit is set. Only the active state's loop policy is armed; a scheduled wake retains the active linked task until an explicit transition. A state-local `maxFires` pauses the workflow controller when exhausted. `startImmediately` opts into an initial idle wake; otherwise the first wake follows the cron schedule.

## Run invariants

- `currentState` always names a definition state.
- `transitionSeq` increases exactly once for every accepted transition.
- `attemptsByState` increases when a state is entered.
- `stateFireCounts` records delivered scheduled wakes by state and survives state transitions and recovery.
- `lastTransition` records source, destination, outcome, evidence, timestamp, and sequence.
- `activeTaskId`, when present, belongs to the current state transition sequence and remains nonterminal until `WorkflowTransition` settles that attempt.

## Compatibility

Existing cron, event, hybrid, dynamic, and backlog loops have no `workflow` property and keep their current behavior. `LoopUpdate` remains the continuation API for legacy dynamic loops. Workflow tools are explicit and do not change provider RPC requirements; external providers receive workflow ownership through the existing task metadata field when tasks are created.
