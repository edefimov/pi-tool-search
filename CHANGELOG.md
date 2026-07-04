# Changelog

## [0.4.0] - 2026-07-02

### Bug Fixes
- Fix the `tool_search` infinite loop where the agent kept calling `tool_search` with already-active tool names instead of calling the enabled tool.

### Changed
- Root cause: pi freezes the tool list per agent run (`createContextSnapshot` in `pi-agent-core`), so a tool enabled mid-run via `setActiveTools` is invisible to the request schema and to tool dispatch until a fresh run starts. `setActiveToolsByName` also reassigns `state.tools` to a new array, so the in-flight run never sees it.
- `tool_search` now returns `terminate: true` to end the current (stale) run immediately, then schedules a hidden fresh turn once the agent is idle. That fresh turn takes a new snapshot which includes the enabled tools, so the model can call them directly instead of looping on `tool_search`.
- Trade-off: one extra turn boundary per `tool_search` call (the agent auto-continues).

## [0.3.6] - 2026-04-24

### Bug Fixes
- Clear footer status when `toolSearch.showToolSearchFooterStatus` is `false`, and re-read setting each refresh so settings changes take effect without stale status.
- Add explicit `showToolSearchFooterStatus` config name with backward compatibility for older status keys.

## [0.3.5] - 2026-04-23

### Other
- Add `pi install npm:pi-tool-search` command to README

## [0.3.4] - 2026-04-23

### Other
- Clarify core defaults and token-saving purpose

## [0.3.3] - 2026-04-23

### Bug Fixes
- Refresh active tools on every `turn_start`, not only fresh user prompts, so unlocked tools stay available during agent-loop continuations
- Queue hidden steer hint after successful `tool_search` so agent can continue/retry without waiting for another user message
- Stop showing visible retry guidance in `tool_search` results and narrow hidden retry hint so successful same-turn tool calls are not repeated

### Other
- Document same-response activation caveat and recovery behavior in `README.md`

## [0.3.2] - 2026-04-23

### Bug Fixes
- Split `tool_search` description into "Already active" and "Hidden" sections so LLM skips redundant enable calls
- Add `grep` and `find` to default core tools (always enabled alongside `read`, `write`, `edit`, `bash`)

## [0.3.1] - 2026-04-23

### Other
- Add repository field to package.json

## 0.3.0

- Renamed from `pi-lazy-tools` to `pi-tool-search`
- Config key changed: `lazyTools` → `toolSearch` in `settings.json`
- `showStatus` config option: show/hide `N / total tools` footer status (default: on)
- Provider-agnostic: removed payload-level filtering, relies solely on `setActiveTools`
- `readUserConfig()` consolidates all settings reads into one call

## 0.2.0

- User config: add `"toolSearch": { "alwaysEnabled": ["lsp", "grep"] }` to `settings.json` to pre-unlock tools beyond the defaults
- Reads config at each `session_start` — no reinstall needed after changes

## 0.1.0

- Initial release
- Manifest-aware `tool_search` gate
- `names: string[]` batch enabling
- Per-turn manifest refresh via `before_agent_start`
