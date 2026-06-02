# Differential Review Report

## Update — 2026-06-02

### Resolved audit finding
- **Resolved:** recurring `event` / `hybrid` loops now clean themselves up immediately when `maxFires` is reached on the final allowed fire.
- **Implementation:** `src/trigger-system.ts` now removes and deletes recurring event/hybrid loops as soon as `fireCount >= maxFires` after `onFire(...)` completes.
- **Why this mattered:** the previous behavior left one stale active loop behind until the next matching event arrived, which was a real runtime cleanup bug.

### Regression coverage added
- `test/trigger-system.test.ts`
  - recurring `event` loop is deleted immediately at final `maxFires`
  - recurring `hybrid` loop is deleted immediately at final `maxFires`
  - hybrid cleanup also clears scheduled cron state
- `test/index.test.ts`
  - extension-level `LoopCreate`/`LoopList` path confirms the loop is gone immediately after the final allowed event fire

### Validation status
- `npm run lint` ✅
- `npm run typecheck` ✅
- `npm run test` ✅
- `npm run build` ✅
- Current suite: **112 passing tests**

## Scope
Reviewed recent uncommitted changes in:
- `src/index.ts`
- `src/ui/widget.ts`
- `test/index.test.ts`
- `test/widget.test.ts`
- `README.md`

## Risk Summary
- **Overall risk:** Medium
- **Primary areas affected:** runtime task fallback routing, UI/widget behavior, interactive command registration
- **Security impact:** Low direct security impact; main risks are state-management regressions and missing coverage around command behavior

## Findings

### 🟡 Warning
`src/index.ts` - Native task fallback is covered for registration and file persistence, but not for interactive `/tasks` flows or loop-driven task lifecycle integration.

**Why it matters:**
The new `/tasks` command and interactive actions (`Start`, `Complete`, `Reopen`, `Delete`) are stateful and user-facing. Regressions here would not be caught by current tests. Similarly, native fallback behavior for `autoTask`, `hasPendingTasks()`, and `cleanDoneTasks()` is only indirectly covered.

**Recommended follow-up:**
Add tests for:
- `/tasks` command registration and quick-create path
- native `autoTask` creation path
- `hasPendingTasks()` using native fallback
- completed-task sweep behavior for native tasks

### 🟢 Suggestion
`src/ui/widget.ts` - Compact widget behavior is appropriately simplified and focus-oriented.

**Good pattern:**
The single-line status approach reduces noise and matches the intended UX. Showing only active/next task focus text is a good constraint.

## Test Coverage Review

### Covered well
- Native tool registration when `pi-tasks` is absent/present
- Native task persistence path (`.pi/tasks/tasks.json`)
- Compact widget states:
  - `none`
  - monitor-only count
  - loop + monitor count
  - active task focus text
  - next task focus text
  - retained widget rendering after content clears

### Coverage gaps
- No tests for `/tasks` command behavior beyond registration
- No direct tests for native `TaskUpdate` → widget focus transitions
- No direct tests for native `cleanDoneTasks()` sweep behavior
- No end-to-end tests for `LoopCreate(autoTask: true)` using native fallback

## Review Verdict
- **No merge-blocking issues found**
- Safe to release after version bump and validation
- Recommended follow-up: add native task lifecycle command/integration tests in a later pass
