# Contributing to @trevonistrevon/pi-loop

Thanks for contributing! This document covers local dev setup, conventions, and workflow.

## Getting Started

```bash
git clone https://github.com/trvon/pi-loop.git
cd pi-loop
npm install
```

## Scripts

| Command | Description |
|---|---|
| `npm run typecheck` | TypeScript type checking (`tsc --noEmit`) |
| `npm run lint` | Lint with Biome |
| `npm run lint:fix` | Auto-fix lint issues |
| `npm test` | Run tests (`vitest run`) |
| `npm run test:watch` | Watch mode |
| `npm run test:coverage` | Run tests with coverage (used in CI) |
| `npm run test:e2e` | Run `test/e2e/reminder-injection.sh` (self-skips without a local llama server) |
| `npm run build` | Compile TypeScript |

## Architecture

See `AGENTS.md` for the full architecture overview and directory tree, including `src/rpc/` (vendored cross-extension RPC) and `src/api.ts` (public `@trevonistrevon/pi-loop/api` subpath — the only supported import path for external consumers). Key modules:

- **`src/index.ts`** — Extension entry: registers tools, `/loop` `/tasks` commands, widget lifecycle, cross-extension RPC server
- **`src/types.ts`** — Core types: `LoopEntry`, `MonitorEntry`, `Trigger` variants
- **`src/store.ts`** — File-backed CRUD with pid-based file locking (atomic write → rename)
- **`src/scheduler.ts`** — Timer-based cron scheduler with per-loop jitter and 7-day expiry
- **`src/trigger-system.ts`** — Unified engine: cron timers + pi event subscriptions + hybrid debounce
- **`src/monitor-manager.ts`** — `ChildProcess` wrapper: stdout/stderr streaming as pi events
- **`src/loop-parse.ts`** — Human interval parsing (`5m` → cron), cron matching, next-fire computation
- **`src/runtime/native-task-rpc.ts`** — `tasks:rpc:*` server for the native fallback task store
- **`src/ui/widget.ts`** — TUI widget rendering active loops + monitors above the editor

## Conventions

- **TypeScript 6.x** strict mode, ES2022 target, bundler module resolution
- **No comments unless answering "why"** — never "what"
- **`debug(...)`** helper gated on `PI_LOOP_DEBUG` env var, logs to stderr
- **`textResult(msg)`** helper for uniform tool output strings
- **Tool params** use `Type.Object()` with description strings from `typebox`
- **File-backed stores** use atomic write (write tmp → rename) + pid-based file locking

## Testing

Tests are co-located in `test/` as `<module>.test.ts`. The suite uses:

- **vitest** with `describe`/`it`
- In-memory stores for unit tests
- `tmpdir` for file-backed store tests
- `vi.useFakeTimers()` for scheduler tests
- Mocked pi eventbus for monitor-manager tests

```bash
npm test            # Run once
npm run test:watch  # Watch mode
```

### Manual fixtures (not run in CI)

- `benchmarks/experiment-sim.js` — synthetic monitor fixture: prints periodic `iteration N/M, loss=...` lines and handles `SIGTERM` with a checkpoint message. Used to manually exercise `MonitorCreate` streaming, `onDone`, and stop handling. Run with `node benchmarks/experiment-sim.js`. Not wired into CI by design — it's a fixture, not an assertion.
- `test/e2e/reminder-injection.sh` (`npm run test:e2e`) — drives a real `pi` session against a local llama server to validate loop/reminder injection end to end. Requires a model server reachable at `localhost:2276`; the script checks for it and self-skips (exit 0) when absent. Never runs in CI — there is no llama server in the CI environment.

## Pull Request Workflow

1. Fork, branch, implement
2. Ensure `npm run lint`, `npm run typecheck`, and `npm run test:coverage` all pass, then `npm run build`
3. Open PR against `main`

CI (`.github/workflows/ci.yml`) runs the same validation in this order on Node 20.x and 22.x: `lint` → `typecheck` → `test:coverage` → `build`.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
