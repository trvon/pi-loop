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
| `npm run build` | Compile TypeScript |

## Architecture

See `AGENTS.md` for the full architecture overview. Key modules:

- **`src/index.ts`** — Extension entry: registers 6 tools + `/loop` `/loops` commands + widget lifecycle
- **`src/types.ts`** — Core types: `LoopEntry`, `MonitorEntry`, `Trigger` variants
- **`src/store.ts`** — File-backed CRUD with pid-based file locking (atomic write → rename)
- **`src/scheduler.ts`** — Timer-based cron scheduler with per-loop jitter and 7-day expiry
- **`src/trigger-system.ts`** — Unified engine: cron timers + pi event subscriptions + hybrid debounce
- **`src/monitor-manager.ts`** — `ChildProcess` wrapper: stdout/stderr streaming as pi events
- **`src/loop-parse.ts`** — Human interval parsing (`5m` → cron), cron matching, next-fire computation
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

## Pull Request Workflow

1. Fork, branch, implement
2. Ensure `npm run typecheck`, `npm run lint`, and `npm test` all pass
3. Open PR against `main`

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
