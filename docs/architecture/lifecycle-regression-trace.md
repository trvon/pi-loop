# Lifecycle regression trace

This trace records the evidence-backed origin of the lifecycle gaps covered by the remediation suite. It distinguishes a single introducing change from a later interaction that made an older assumption unsafe.

## Findings

| Gap | History evidence | Classification |
|---|---|---|
| Buffered workflow wake survives authoritative mutation | Idle-driven notification buffering predates workflows (`ba19246`, `8101661`). Workflow state execution identity arrived in `c770bac`; adaptive reissue arrived in `8464b17`. Delivery remained generation-fenced but did not compare the queued workflow revision/state/sequence/execution against `LoopStore`. | Cross-feature interaction, not one isolated persistence regression. |
| Monitor completion resumes an expired workflow | Workflow monitor waits were introduced in `285ab09`. Observable atomic expiry arrived later in `b5cc3a2`/`65dd735`, but the monitor completion callback still cleared the wait and rearmed directly. | Interaction introduced when expiry became authoritative without joining the monitor-resume path. |
| Claimed task instructions accept an unowned edit | Native RPC detail edits were introduced in `7335eff`. Claim hardening in `03a3a53` protected terminal settlement/deletion but left `updateDetails` after the claim check. | Incomplete authority expansion in `03a3a53`. |
| New workflow definitions accept unreachable states | Base workflow validation arrived in `8464b17` and validated keys, targets, terminal shape, tasks, loops, and size, but never traversed from `initialState`. | Missing invariant since initial validator introduction. |
| Orchestration settlement suppresses provider-native completion | Durable orchestration settlement and `subagents:rpc:consume` were introduced in `cdba925` and merged in `d1e5b82`. Consuming intentionally transferred presentation to pi-loop, whose bounded aggregate wake was not equivalent to the provider's native result surface. | Original completion-ownership design mismatch. |

The signed RED commit captures each behavior before the GREEN production commit. The GREEN implementation does not infer semantic workflow transitions from notifications, monitor output, task edits, or subagent prose.

## Issue #75: separate deterministic cause

Issue [#75](https://github.com/trvon/pi-loop/issues/75) is not caused by the five gaps above.

Commit `44e578f` introduced free-text `/loop <goal>` dynamic controllers with an implicit `maxFires: 20`. The first fire is immediate. On fire 20, `store.fire()` durably records the fire and the runtime then deletes the ordinary controller before emitting its final wake. That wake still describes the loop as persistent and instructs `LoopUpdate`, producing the observed sequence:

```text
fire 20 persisted -> controller deleted -> final wake delivered ->
LoopUpdate: Loop not found -> LoopList: empty
```

At roughly hourly continuation, the immediate fire plus 19 later fires explains the reported 19–20 hour recurrence. This is a bounded-lifecycle and final-message defect, not evidence that `LOOP_FIRED` failed to persist.

Deletion does not reset `nextId`; the reducer removes only the loop entry. Recreating in the same store therefore yields the next ID. A later `Loop #1 iter 0` indicates a different/missing session store path, memory scope, or a separate unresolved defect. A same-session reset claim requires the exact session ID, resolved store path, and before/after current and `.prev` snapshots.

Issue #75 should be fixed in a separate RED-to-GREEN PR by removing the undocumented command-only cap or making retirement explicit and preventing an impossible final `LoopUpdate` instruction. The lifecycle-authority PR must not claim to close #75.
