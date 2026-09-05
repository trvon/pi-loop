# Bounded harness review campaigns

This is a test-only reference policy and regression inventory, not a shipped controller or a claim of exhaustive coverage. `test/helpers/review-campaign.ts` accepts trusted fixture evidence; it does not obtain provider receipts, hash worktrees, enforce wall-time/spend, or authorize workflow transitions.

## Freeze the campaign

Record the exact input digest (including relevant uncommitted files/configuration), allowed scope and direct authority/transport neighbors, required partitions/invariants, writer ownership, call and repair budgets, and reserved capacity for validation/reporting. Suggested starting policy: one discovery sweep, up to two repair batches, and one delta closure sweep. These are tunable limits, not evidence of optimal review quality.

Each mandatory partition supplies an explicit `ok`, `failed`, or `skipped` outcome and snapshot. Never filter failed workers out before deciding whether discovery was dry. Multiple observations for one partition need explicit adjudication; last-arrival wins is not safe.

Findings have stable invariant/root-cause keys, snapshot and `confirmed`, `refuted`, or `unresolved` verdicts. Repeated confirmed findings still block closure; repeated refutations apply only to unchanged reviewed inputs. Contradictory verdicts need adjudication, not majority authority. Preserve history outside the final evidence view; after edits, revalidate or explicitly scope unchanged evidence rather than silently relabeling old results.

## Stop and report honestly

- `repair`: confirmed in-scope blocker, complete coverage, known worker termination, remaining fixed budget.
- `clean`: complete final-snapshot coverage, no unresolved/confirmed blockers, final gates and closure passed, worker termination proved.
- `incomplete`: failed/missing/stale coverage, contradictory/unresolved evidence, unproved termination, unavailable validation, or exhausted budget with work left.

Provider abort acknowledgement and `stopped` status alone do not prove quiescence. Quiescence does not prove rollback or safe replay. A missing result or empty array is not a successful review. The reference model permits successful completion exactly at a budget boundary, but no further repair. Account for failed calls and retain counters across snapshot changes.

Use per-item pipelines for independent validation and a barrier only for global deduplication/coverage accounting. Do not silently extend scope for unrelated adjacent defects. Report them separately; a severe out-of-scope release blocker requires a decision, not an unbounded new audit.

## Regression inventory

`test/fixtures/harness-boundaries.json` maps a bounded initial selection of persistence, transport, notification, teardown, and campaign invariants to exact existing test titles. `test/harness-boundaries.test.ts` checks unique IDs and live references. The ordinary suite executes the referenced regressions; the manifest check alone does not certify their behavior.

Run:

```bash
npx vitest run test/review-campaign.test.ts test/harness-boundaries.test.ts
npm test
```

Add minimized counterexamples to the nearest runtime/reducer test, then add their invariant mapping. Expand generated traces toward multiple outstanding dispatches and selected shutdown/mutation/callback interpositions. Keep the existing three-tool routing classifier distinct from future full-tool behavior benchmarks.

Residual reports should state unreviewed boundaries, stale evidence, unresolved claims, unknown workers, skipped live environments, exact input digest, and limits reached. Track false-clean rate, rediscovery, seeded precision/recall, budget overshoot and mutation-before-controller; test counts and coverage percentages are not completeness claims.
