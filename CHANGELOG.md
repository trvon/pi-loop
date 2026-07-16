# Changelog

## [0.6.1](https://github.com/trvon/pi-loop/compare/pi-loop-v0.6.0...pi-loop-v0.6.1) (2026-07-16)


### Features

* **loop:** add dynamic goal loops ([44e578f](https://github.com/trvon/pi-loop/commit/44e578f5e7cdeaf6aee765835892dd975d2fe913))


### Bug Fixes

* fast failing monitor hit error before onDone registered. Orca/agent never woke. ([56cd43d](https://github.com/trvon/pi-loop/commit/56cd43d2b41a6b0df5c10cccb11c0fa04981d83a))
* **loop:** harden dynamic goal loops ([036fbaf](https://github.com/trvon/pi-loop/commit/036fbaff9a8c7c60acefce4dec757bfc1e6ff8d0))

## [0.6.0](https://github.com/trvon/pi-loop/compare/pi-loop-v0.5.8...pi-loop-v0.6.0) (2026-07-02)


### ⚠ BREAKING CHANGES

* package exports map blocks deep src/ imports — consumers must use @trevonistrevon/pi-loop/api. tasks:updated now reports previousStatus at edit time, not pre-transition.

### Features

* add maxFires for self-limiting loops, event-driven prompt steering ([52b50f0](https://github.com/trvon/pi-loop/commit/52b50f0d2b8c0b1df6aa74b09a8561807b549fe6))
* add native task fallback and compact task tracker ([6b5b6ff](https://github.com/trvon/pi-loop/commit/6b5b6fff53cc7810242e4f9081fe6d21b318c654))
* add task decomposition guidance to TaskCreate prompt ([4c51e72](https://github.com/trvon/pi-loop/commit/4c51e72a7317e1433cdb5bed6cfc9dfa521b5bfb))
* add tasks:rpc:clean RPC for sweeping done tasks ([73812ed](https://github.com/trvon/pi-loop/commit/73812ed4c3efeb08e97908e6de6435f65c768440))
* auto-create task worker loop at backlog threshold ([430663a](https://github.com/trvon/pi-loop/commit/430663a8042560688e08bd08129ea57b190ccecc))
* canonical rpc module + init-time task server ([7335eff](https://github.com/trvon/pi-loop/commit/7335eff6440452178ae9db3cb22a49098ad3953d))
* generalize task backlog loop cleanup ([9132948](https://github.com/trvon/pi-loop/commit/9132948dc9e22cda32adf6e8c5e13a7203f9c864))
* goal prompt and loading refinements ([b31df23](https://github.com/trvon/pi-loop/commit/b31df23c240f0bde7fb69fb8ea702429576276c7))
* prune completed tasks after successful git commit ([cba120b](https://github.com/trvon/pi-loop/commit/cba120be3a7fcdf71b7f7649b414577412d26a94))
* refining monitor interface ([66a6007](https://github.com/trvon/pi-loop/commit/66a60077093f40c258efeeb971f6f8db74e24f83))
* show worker-loop hint when pending tasks reach 5+ ([74dbf2c](https://github.com/trvon/pi-loop/commit/74dbf2cbf7f55a4206762eee3731798527537ab5))
* skip loop fires when autoTask loop has no pending tasks ([f2feb07](https://github.com/trvon/pi-loop/commit/f2feb079d5b520ed4c4dd0dc85d5b385efc45c45))
* **tasks:** add native rpc update and backlog signals ([31d06f6](https://github.com/trvon/pi-loop/commit/31d06f61fce1333c359f0d38def7406474144f8b))
* **tasks:** emit native task events with previousStatus tracking ([61b49ea](https://github.com/trvon/pi-loop/commit/61b49ea5703597b02754998269edfdc5b2018ebb))


### Bug Fixes

* add trigger validation, readOnly flag, and edge-case tests ([91baa07](https://github.com/trvon/pi-loop/commit/91baa07884bc20d760c7a3642c3ec462997fc0d3))
* auto-delete worker loop when task backlog clears ([502fa10](https://github.com/trvon/pi-loop/commit/502fa106b8862c06648e6be373e5980d2af18f6f))
* auto-expire monitor:done loops, buffer output, show completed monitors ([a3ec5de](https://github.com/trvon/pi-loop/commit/a3ec5de5847d67bddee9c572079b559b03e35f3f))
* deduplicate loop follow-up messages to prevent flood ([1613511](https://github.com/trvon/pi-loop/commit/1613511a2453d346edb59919beed2bdb18c05f63))
* delete done loops/monitors immediately instead of marking expired ([43f5220](https://github.com/trvon/pi-loop/commit/43f5220a3e6d807234e4bdb7611e44c0fa7468ec))
* delete event maxFires loops immediately ([12335e7](https://github.com/trvon/pi-loop/commit/12335e75dcf8d17a2c887966cae180d2b2f848da))
* deliver monitor onDone wakes without event dependency ([79d6a8b](https://github.com/trvon/pi-loop/commit/79d6a8b925aa98e8de0ea1b12addd5e0d2db0c47))
* derive jitter ceiling from cron step, delete expired event loops ([6d13935](https://github.com/trvon/pi-loop/commit/6d13935e79d2367072bec027d5ef2cb430eff44a))
* flush buffered worker wakes on agent end ([7a7dedf](https://github.com/trvon/pi-loop/commit/7a7dedf3ec7f16eb63edbfaf93e5dae9ed7a8f25))
* harden TaskUpdate prompt to prevent taskId alias errors ([5dfefd9](https://github.com/trvon/pi-loop/commit/5dfefd96bb08c29d192de472c6224ac434394b6f))
* **injection:** use before_agent_start message, not tool_result ([99a6317](https://github.com/trvon/pi-loop/commit/99a6317aabde8ce9d4f9e0c3065f42b6c6111259))
* loop trigger fix ([619f32c](https://github.com/trvon/pi-loop/commit/619f32c48134d9cc1376a89a62a7c8d729321143))
* **monitor:** make MonitorManager spawn-injectable, fix CI test timeouts ([f277646](https://github.com/trvon/pi-loop/commit/f277646b95369b43508fbbc8cc7eef5e37580781))
* **monitor:** prune stopped/timed-out monitors ([a46f6e8](https://github.com/trvon/pi-loop/commit/a46f6e8f2b99fa39bd11ff22d1a34999e1ac4434))
* only dedup recurring loop fires, always deliver one-shot events ([352e50e](https://github.com/trvon/pi-loop/commit/352e50e1de14ecd8d884b18a8e72572270ca90e9))
* **persist:** expire event loops on session start, clean stale monitors ([7f0876d](https://github.com/trvon/pi-loop/commit/7f0876d821e93e663f43ec2d5351bc9a37223b4b))
* recommend 5m default interval in LoopCreate task-continuation prompt ([1af3bcd](https://github.com/trvon/pi-loop/commit/1af3bcd35a2782f9fc333559d293c665db76c234))
* release please fix ([16e2304](https://github.com/trvon/pi-loop/commit/16e2304ea3112664c12c65b4e098e04d390f93f0))
* **reminders:** make loop reminder directive, not informational ([e21174d](https://github.com/trvon/pi-loop/commit/e21174df3d1d9403684e094f5763db33ed9cb732))
* repair native task fallback compilation ([a8cef04](https://github.com/trvon/pi-loop/commit/a8cef04eabd8a8af404d27ffa756266ee6a188ec))
* **runtime:** unref retention timer, swallow heartbeat pump errors ([602816b](https://github.com/trvon/pi-loop/commit/602816b3abb06859a0268c02119cc753de03decb))
* scope native task files by session, prevent cross-session leakage ([0436710](https://github.com/trvon/pi-loop/commit/04367102414dd56f7668e1522b91c6f089490979))
* **tasks:** gate late native RPC probes ([c97f4ad](https://github.com/trvon/pi-loop/commit/c97f4ad6800c00b9858c1a8e640f13e699e0c26a))
* **tasks:** guard native fallback registration ([7d3b74a](https://github.com/trvon/pi-loop/commit/7d3b74abfa637bbe370ae232b8067e7bc5205ea1))
* **trigger:** auto-expire non-recurring event loops ([178f9fd](https://github.com/trvon/pi-loop/commit/178f9fd6a6548a04307f3ed83935068a235c24d3))
* use pi.hasPendingMessages() instead of bespoke tracking Set ([dab60d4](https://github.com/trvon/pi-loop/commit/dab60d46340fab04ae74b80044ad03b6b0ca9fe8))


### Performance Improvements

* **test:** replace real 6.1s waits with fake-timer advance in onDone tests ([c713ad3](https://github.com/trvon/pi-loop/commit/c713ad36f958d53e75c4c7d7fd723c06ee420543))

## [0.1.2]

- Added `onDone` parameter to `MonitorCreate` — auto-creates a completion loop so the agent is notified when a background process finishes, no polling needed
- Updated tool descriptions and prompt guidelines for the MonitorCreate + LoopCreate pairing



## [0.1.1]

- Migrated peer dependencies from `@mariozechner/pi-*` to `@earendil-works/pi-*`
- Fixed `.npmignore` to include `src/` and `dist/` directories

## [0.1.0] — Initial Release

### Tools

- **LoopCreate** — Create scheduled (cron), event-triggered, or hybrid re-wake loops
- **LoopList** — List all active loops with IDs, triggers, status, and next-fire times
- **LoopDelete** — Delete or pause a loop by ID
- **MonitorCreate** — Start a background command that streams output via `monitor:output` pi events
- **MonitorList** — List monitoring processes and their status
- **MonitorStop** — Stop a running monitor (SIGTERM → 5s → SIGKILL)

### Commands

- **`/loop [interval] [prompt]`** — Interactive TUI loop creation
- **`/loops`** — View, create, cancel, and configure loops

### Features

- Three trigger types: cron (timer), event (eventbus), hybrid (both with debounce)
- File-backed persistence with pid-based file locking and atomic writes
- Cron scheduler with per-loop jitter and 7-day expiry
- Background process monitoring with stdout/stderr streaming
- Persistent TUI widget showing active loops and monitors
- System-reminder injection for loop fires (mirrors pi-tasks pattern)
- Self-paced loop mode for dynamic interval scheduling
- `@tintinweb/pi-tasks` integration with auto-task creation

### Configuration

- `PI_LOOP` env var for store path override / disable
- `PI_LOOP_SCOPE` env var for `memory` | `session` | `project`
- `PI_LOOP_DEBUG` env var for debug logging

### Limits

- Maximum 25 active loops
- Maximum 25 running monitors
