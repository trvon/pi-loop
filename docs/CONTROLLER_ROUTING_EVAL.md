# Controller routing evaluation

pi-loop chooses controllers by work semantics, not by the nouns in a user request:

- ordered phases, conditional outcomes, rework, or durable handoff → workflow;
- independently completable, assignable backlog items → standalone tasks;
- recurring observation or a self-paced goal without phase routing → loop.

The routing evaluation checks whether clean agents apply that classifier when users ambiguously say “task,” “series of tasks,” or “loop.” Scenario prompts deliberately do not name `WorkflowCreate`, `TaskCreate`, or `LoopCreate`.

## Fixed scenario set

`test/fixtures/controller-routing-scenarios.json` is the versioned source of truth.

| Scenario | Ambiguity | Expected controller |
| --- | --- | --- |
| `ordered-task-series` | Ordered/retry work called a series of tasks | One workflow |
| `phased-request-called-loop` | Conditional phased work explicitly called a loop | One workflow |
| `independent-task-series` | Three assignable independent items | Three standalone tasks |
| `bounded-recurring-loop` | Bounded ten-minute observation | One cron loop |
| `self-paced-idle-loop` | Evolving goal with no phases or schedule | One idle loop |
| `singular-task-with-rework` | Ordered/retry work called one task | One workflow |

The first three are the baseline. The last three are hold-outs that exercise nearby boundaries without repeating the same wording.

## Judgment

Each model/scenario run starts a clean Pi RPC process in a temporary workspace with only the three controller-creation tools exposed. The harness observes actual validated tool calls rather than asking the model which tool it would hypothetically use.

The fixed checklist is:

1. **[critical] Route:** exact successfully created controller type and count, with no competing controller.
2. **[critical] Execution:** the final expected controller attempt passes Pi/tool schema validation; repaired in-turn schema attempts are recorded as retries rather than routing failures.
3. **Arguments:** the successfully created controller represents the scenario semantics, including rework routes, independent descriptions, cadence bounds, or idle configuration.
4. **Single turn:** successful controller creation occurs in the first user-request agent run; an immediate controller wake does not count as another routing turn.

A scenario succeeds only when every critical item passes. Accuracy is the fraction of all four items that pass. Reports also record duration, tool-call and retry counts, agent-run count, bounded assistant text, errors, and event traces. A failed argument or single-turn item lowers accuracy even when critical routing succeeds.

## First-attempt schema conformance

Evaluation version 2 reports two fields separately from the fixed four-item checklist:

- `firstAttemptValid`: the first observed controller-creation batch has the expected type/count and every call has an accepted tool result. For the independent-task case, the batch contains three calls, not one.
- `firstAttemptSemantic`: that valid batch also passes the scenario's existing argument checks.

An invalid first call repaired in-turn can still pass routing and score 100% on the original checklist. Both first-attempt fields remain false. Conversely, an accepted definition that omits the requested rework can pass validity but fail semantics. Neither field changes critical-success rules, accuracy, retries, or single-turn judgment.

The observation boundary is `tool_execution_start`/`tool_execution_end`, not hypothetical tool choices or every raw model token. Missing or rejected results do not pass. Response model/provider/API metadata is captured separately from the requested model string; absent metadata remains absent. Reports include Pi/Node versions and explicitly count model observations dropped by the eight-entry bound. Argument checks are structural scenario checks, not proof that an entire workflow executes correctly. A timeout/process/extension failure can still omit in-flight observations and earlier completed scenarios for that model from the failed report; version-probe recovery does not establish complete failed-run retention.

Deterministic tests cover repaired attempts, accepted-but-wrong semantics, missing/error results, competing controllers, multi-task batches, late failed calls, timing, and input non-mutation. The published usage-guide example also runs through the production definition validator and LoopStore; cadence/rework misuse is tested independently. These tests establish measurement and example contracts, not model effectiveness.

## Run across models

```bash
PI_LOOP_LIVE_ROUTING_MODELS="openai-codex/gpt-5.6-sol:minimal,anthropic/claude-sonnet-4-6" \
npm run test:e2e:routing
```

Use one configured model through the existing variable:

```bash
PI_LOOP_LIVE_MODEL="openai-codex/gpt-5.6-sol:minimal" npm run test:e2e:routing
```

Run a subset while debugging:

```bash
PI_LOOP_LIVE_ROUTING_SCENARIOS="phased-request-called-loop,self-paced-idle-loop" \
PI_LOOP_LIVE_MODEL="openai-codex/gpt-5.6-sol:minimal" \
npm run test:e2e:routing
```

The bounded report is written to `.artifacts/live-controller-routing/latest.json`. Missing model configuration produces `SKIP`, not a false pass.

## Prompt-tuning baseline

Before adding the live harness, fresh clean-slate executors ran the three baseline scenarios and three unseen hold-outs with fixed checklists. Default, Haiku, and Sonnet executor classes all selected the intended controller with 100% routing accuracy and zero routing-judgment retries. The phased-loop executor noted that overriding the word “loop” was inferred from the semantic classifier rather than stated literally, but it still routed correctly.

Because no critical or normal routing item failed across two consecutive passes and hold-out accuracy did not drop, the shipped prompt copy was left unchanged. This avoids tuning wording to hypothetical failures. Future prompt edits should be driven by reproducible failures from the live multi-model artifact, followed by fresh hold-out runs.

## Initial live result

The initial full RPC run with `openai-codex/gpt-5.6-sol:minimal` passed all six scenarios at 100% checklist accuracy. The three workflow scenarios each repaired one invalid first attempt in the same user-request turn after incorrectly treating a state-level `loop` field as rework metadata. Their final workflow calls passed and preserved the intended route; the task and loop scenarios required no retries. This is recorded as schema-repair evidence, not hidden or counted as a controller-selection failure.

## Current bounded baseline

An unchanged-copy run on 2026-10-06 requested `openai/gpt-6.1-sol:minimal` using Pi1.0.4 and Node26.10.0. All six fixtures passed all four checklist items. Each workflow case used one creation call with zero repairs. The older harness did not capture response model metadata, so the model string identifies the requested configuration, not an independently observed response model. The existing three hold-outs were included; they are now seen controls, not fresh unseen validation.

This one-model, one-pass run did not reproduce the historical schema problem. Compact tool copy and examples were left unchanged. No guidance improvement, model-wide failure rate, empirical convergence, or operator benefit is claimed. Proposed multi-model/repeat and operator studies remain unrun. Future tuning requires a reproducible current failure, pinned copy/model provenance, first-attempt semantic comparisons, and fresh frozen hold-outs; provider errors and `SKIP` are not passes.

A 9-second startup window is intentional. Native fallback task tools now register at `session_start`, before the first request, so the window no longer guards tool registration; it is kept so the protocol-v2 `pi-tasks` probe has settled before controller judgment is measured.
