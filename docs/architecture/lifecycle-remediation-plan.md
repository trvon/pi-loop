# Lifecycle remediation plan

**Baseline:** `docs/lifecycle-ownership-audit.md` at `b42e1a1`

**Rule:** RED tests and production fixes remain separate from PR #74. A RED test must encode an agreed authority or lifecycle invariant, not merely freeze one preferred implementation.

## 1. Remediation order

| Order | Gap | Contract | RED location | Fix slice |
|---|---|---|---|---|
| 1 | Same-generation stale workflow wake | Before delivery, re-read LoopStore and require the queued workflow identity to still match controller status, definition revision, state, transition sequence, and execution identity. Deleted, paused, transitioned, or reissued work is dropped. | `test/notification-runtime.test.ts` or an index-level notification integration test | Add a relevance callback/fingerprint and preserve generation fencing. |
| 2 | Monitor completion revives expired workflow | Monitor completion must settle expiry before clearing/rearming/waking. At or after `expiresAt`, no workflow work fires. | `test/monitor-ondone-runtime.test.ts` | Route completion through one LoopStore operation that returns resumed, expired, or stale. |
| 3 | Claimed task instructions are mutable without bearer | A live claim protects subject and description changes as well as terminal/delete operations. Same-value edits may be idempotent. | `test/native-task-tools.test.ts`, `test/native-task-rpc.test.ts`, and mutation/store coverage | Apply the canonical claim check before detail mutation across tools and RPC. |
| 4 | Initial workflow definitions accept unreachable states | Every state in a newly created definition must be reachable from `initialState`. Terminal reachability remains a separate policy decision. | `test/workflow-reducer.test.ts` or `test/workflow-definition.test.ts` | Reuse a bounded graph traversal in base definition validation. |
| 5 | pi-loop suppresses `@tintinweb/pi-subagents` completion output | Settling a pi-loop orchestration item must not automatically mark the provider result consumed before the user/model receives an equivalent result surface. | `test/orchestration-runtime.test.ts` | Choose one completion owner: provider-native notification, or an equivalent pi-loop visible result followed by consume. |
| 6 | Workflow execution history is unbounded | Decision required before RED: choose retention size and whether old evidence is summarized, externalized, or transition-rejected. | Deferred | Add a public bounded-history contract, then RED file-backed cycle/reissue tests. |
| 7 | Unleased task compatibility paths | Decision required: either retain/document manual `in_progress` and pending→terminal operations or require claims with migration handling. | Deferred | Align runtime and prompt contract after compatibility review. |
| 8 | Bulk prune is invisible to subscribers | Decision required: per-task events, one bounded prune event, or snapshot invalidation. | Deferred | Extend provider-neutral task event contract only after choosing semantics. |
| 9 | Orphan/abandonment visibility | Add read-only diagnostics only after authoritative states above are stable. | Deferred | Derive orphan categories; never auto-delete evidence-bearing controllers. |

## 2. RED test acceptance criteria

### Wake relevance

The test must:

1. queue a workflow wake while delivery is blocked by an active parent;
2. mutate authoritative workflow state before flush;
3. flush in the same session generation;
4. assert no stale instruction is delivered;
5. cover delete plus at least one identity-preserving controller mutation such as transition or reissue.

A generation-only test is insufficient; that behavior already exists.

### Monitor expiry

The test must exercise exact boundary `now === expiresAt` and after-boundary completion. It must assert:

- no trigger is rearmed;
- no wake is emitted;
- the LoopStore controller is authoritatively retired according to its type;
- a pre-expiry completion still resumes exactly once.

The first RED can target runtime behavior; the GREEN slice must add file-backed store coverage.

### Claimed task edits

The test must prove:

- a claimed task rejects a subject/description update without `claimId`;
- a wrong bearer rejects without byte changes;
- the correct live bearer succeeds;
- an expired bearer instructs reclaim rather than silently editing;
- unclaimed task edits remain allowed.

### Workflow graph reachability

The test must reject:

- one disconnected nonterminal state;
- one disconnected terminal state;
- a disconnected cycle.

It must continue accepting reachable cycles and definitions whose reachable nonterminal state intentionally has no terminal route until that separate policy is decided.

### Subagent completion ownership

The first RED test should assert that `dispatch_settled` does not immediately call `subagents:rpc:consume`. This encodes user-visible provider output ownership, not a particular UI implementation.

Before GREEN, choose one of:

- **Provider-owned completion:** do not consume automatically; suppress or deduplicate pi-loop’s separate wake without losing durable attention state.
- **Pi-loop-owned completion:** emit an equivalent visible result with full-result retrieval, then consume only after delivery acknowledgement.

Do not ship a state where both completion paths trigger independent parent turns.

## 3. Policy-dependent decisions

### Execution-history bound

Recommended design direction: retain a bounded recent window plus aggregate counters and a digest/reference for omitted history. Do not silently discard evidence and do not reject a valid terminal transition solely because history storage filled.

Questions requiring review:

- retained record count and byte ceiling;
- whether cancelled and completed records have separate quotas;
- how old evidence is summarized;
- migration of oversized existing snapshots;
- property invariant for transition sequence versus retained history length.

### Standalone task lease strictness

Current manual paths are explicitly tested. Changing them may break `/tasks` users and external providers. Decide whether claims protect autonomous workers only or every `in_progress` task.

### Orchestration ownership

Preferred long-term direction:

- use `@tintinweb/pi-subagents` `SubagentWorkflow` for ordinary fanout and native presentation;
- keep LoopStore authoritative for semantic workflow phases;
- deprecate the duplicate pi-loop finite batch unless its durable retry/recovery contract is required;
- require a stronger status/join RPC before automatic durable workflow-to-agent binding.

## 4. Implementation slices

1. **Notification relevance PR** — stale-wake RED/GREEN only.
2. **Monitor expiry PR** — expiry-before-resume RED/GREEN only.
3. **Task detail authority PR** — bearer-protected edits across native tools/RPC.
4. **Definition reachability PR** — graph validation and property coverage.
5. **Subagent completion UX PR** — one reviewed completion owner plus live `@tintinweb` harness.
6. **History ADR/contract** — no code until retention and migration are approved.
7. **Orphan diagnostics** — read-only surface after lifecycle fixes land.

## 5. Merge gates per slice

- RED failure captured before production edit;
- focused GREEN suite;
- file-backed restart/recovery case where relevant;
- state-preserving rejection/byte comparison;
- property test for reducer/store state machines;
- `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, `npm run test:package`, audit, and `git diff --check`;
- current Linux, Windows, Analyze, and CodeQL;
- live `@tintinweb/pi-subagents` scenario for completion-ownership changes.

## 6. RED evidence

Command:

```bash
npx vitest run \
  test/index.test.ts \
  test/monitor-ondone-runtime.test.ts \
  test/native-task-tools.test.ts \
  test/native-task-rpc.test.ts \
  test/workflow-reducer.test.ts \
  test/orchestration-runtime.test.ts
```

Observed before any production edit:

- 6 failing test files;
- 10 expected failures;
- 189 existing tests passed;
- 3 reachability cases rejected by the new contract but currently return `undefined` (accepted);
- native tool updates currently accept missing, wrong, and expired claim bearers; the RPC surface also accepts a missing bearer;
- 1 stale same-generation wake is delivered;
- 1 expired monitor completion rearms the workflow;
- 1 settled subagent result is immediately consumed.

All edited test files pass primary TypeScript LSP diagnostics. The suite is intentionally RED on this branch; no production source file has been changed.
