# Opt-in workflow contract

Workflow loops are a controller layer over dynamic loops and tasks. They are not the default model for schedules, events, or task backlogs.

## Ownership

- A `LoopEntry.workflow` owns the workflow definition and the persisted run state.
- A task may carry a `TaskWorkflowLink` identifying the owning loop, state, and transition sequence.
- Task status remains independent from workflow state. Completing a task never infers an outcome.
- The model selects an outcome through `WorkflowTransition`; the runtime only validates and persists it.

## Definition

`WorkflowDefinition` version 1 contains an `initialState` and named states. A state has a prompt, optional `task`, outcome map `on`, optional positive `maxAttempts`, or a terminal status of `completed` or `paused`.

Every declared outcome must target a named state. Terminal states may not declare outcomes. A state may be entered at most `maxAttempts` times when that limit is set.

## Run invariants

- `currentState` always names a definition state.
- `transitionSeq` increases exactly once for every accepted transition.
- `attemptsByState` increases when a state is entered.
- `lastTransition` records source, destination, outcome, evidence, timestamp, and sequence.
- `activeTaskId`, when present, belongs to the current state transition sequence.

## Compatibility

Existing cron, event, hybrid, dynamic, and backlog loops have no `workflow` property and keep their current behavior. `LoopUpdate` remains the continuation API for legacy dynamic loops. Workflow tools are explicit and do not change provider RPC requirements; external providers receive workflow ownership through the existing task metadata field when tasks are created.
