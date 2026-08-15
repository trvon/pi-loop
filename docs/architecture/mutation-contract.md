# Mutation Contract

Task, loop, and workflow writes follow an explicit state machine. A successful result means the requested mutation was applied or the requested status was already true. A rejected result includes a specific recovery action; callers must not infer the cause from current state.

## Task status matrix

| From | `pending` | `in_progress` | `completed` | `closed` |
|---|---|---|---|---|
| `pending` | idempotent | apply | apply | apply |
| `in_progress` | reject | idempotent | apply | apply |
| `completed` | reopen | reject | reject | reject |
| `closed` | reopen | reject | reject | reject |

`TaskClaim` moves unfinished work to `in_progress`; a following `TaskUpdate(status="in_progress")` is therefore an idempotent no-op and preserves ownership. Agents should normally omit that redundant update.

A claimed task adds these guards:

| Condition | Result | Recovery |
|---|---|---|
| Terminal update without `claimId` | `claim_required` | Pass the token returned by `TaskClaim` |
| Wrong token | `claim_mismatch` | Read/claim the task and use the current token |
| Expired lease, even with the old token | `claim_expired` | Reclaim the task, then retry with the new token |
| Same owner reclaims before expiry | lease renewal; token and attempt retained | Continue work |
| Same owner reclaims after expiry | new attempt and token | Replace the stale token |
| Delete live claimed work | same claim checks as terminal updates | Pass the live token or wait and reclaim |
| No status/subject/description | `no_changes` | Supply at least one update field |

Detail-only edits remain allowed without a claim token because they do not grant execution ownership. `TaskClaim`, not `TaskUpdate`, is the ownership boundary.

## Loop matrix

| Operation | Active dynamic | Paused dynamic | Cron/event/hybrid | Workflow-owned dynamic |
|---|---|---|---|---|
| `LoopUpdate continue` | update and re-arm | resume, update, and re-arm | reject | reject; use `WorkflowTransition` |
| `LoopUpdate paused` | pause | idempotent pause | reject | reject; use workflow/cancel path |
| `LoopUpdate completed` | delete as complete | delete as complete | reject | reject; use `WorkflowTransition` |
| `LoopDelete pause` | pause | idempotent pause | pause | pause workflow controller |
| `LoopDelete delete` | delete | delete | delete | delete controller and embedded executions |

An invalid `nextInterval`, a wake beyond `expiresAt`, or a stale iteration snapshot is a structured error and cannot update the widget, iteration, store, or trigger registration. Automatic expiry and fire caps pause workflows rather than deleting controllers that still own executions.

## Workflow transition ordering

`WorkflowTransition` validates the declared outcome, the active execution, and the calling runtime's lease before mutating anything. When accepted, the same locked write settles the source execution, records evidence, advances state, and activates the destination execution. A live lease owned by another runtime, or an unowned execution, fails closed with claim-first guidance. There is no cross-store ordering: workflow work never touches the task stores, so no crash window exists between task settlement and state advance.

## Historical rejection patterns

Observed failures mapped to two distinct causes that previously shared the same message:

1. `TaskClaim` immediately followed by `TaskUpdate(status="in_progress")` — redundant status assignment, now idempotent.
2. Completion with the correct but expired token — lease expiry, now reported as `claim_expired` with reclaim guidance.

The mutation layer returns typed rejection codes so tool and RPC messages stay aligned and future cases do not regress to guessed token-mismatch errors.
