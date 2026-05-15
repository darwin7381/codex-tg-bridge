# Changelog

All notable changes to this project. Versions follow [SemVer](https://semver.org/).

## [Unreleased] — 2026-05-15 (later in day)

### Added — `gemini-tg-bridge`

A second bridge in the same repo, sharing the supporting modules
(TelegramClient, SessionMap, TurnStreamConsumer) with the original
codex bridge. The protocol layer is different: Codex uses its
WebSocket app-server JSON-RPC; Gemini speaks the Agent Client Protocol
(ACP) over a stdio subprocess. Same five audit invariants apply.

- **`src/gemini-client.ts`** — spawns `gemini --acp` as a long-lived
  stdio subprocess, frames JSON-RPC 2.0 as NDJSON (one frame per line).
  Implements `initialize`, `session/new`, `session/load`,
  `session/prompt`, `session/cancel`. Handles bidirectional requests
  (`session/request_permission`) so the bridge can route ACP approval
  prompts to Telegram.
- **`src/acp-item-formatter.ts`** — renders ACP `session/update` payloads
  (plan / tool_call / tool_call_update / agent_thought_chunk /
  available_commands_update / etc.) to Telegram-friendly strings.
  `agent_message_chunk` is suppressed here and routed to
  `TurnStreamConsumer` for in-place streaming edits, matching the
  codex bridge's behaviour.
- **`src/gemini-server.ts`** — daemon entry point parallel to
  `src/server.ts`. Reuses TelegramClient + SessionMap +
  TurnStreamConsumer. Dynamic inline-keyboard approval flow: each
  button surfaces one of the server-supplied `options` (ACP's design
  is "agent provides options, client picks", vs codex's fixed enum).
- **`scripts/smoke-test-gemini.ts`** — TG-bypassing smoke test against
  `gemini --acp`. Verifies initialize → session/new → session/prompt →
  stopReason=end_turn. Used to confirm the codex-side smoke pattern
  works on the gemini side too.
- **`launchd/com.btai.gemini-tg-bridge.scout.plist.template`** — single
  LaunchAgent (no separate appserver needed; gemini-server.ts owns the
  gemini --acp lifecycle). Uses the same `@@PLACEHOLDER@@` sentinel
  pattern as the codex templates.
- **`package.json`**: new `start-gemini` script.

### Changed — codex bridge

- **Boot-time auth guard** (`src/codex-client.ts:assertSubscriptionAuth`).
  Refuses to start if `~/.codex/auth.json` reports `auth_mode: "apikey"`.
  Background: this caught us out — `@scout_Codex_bot` had been running
  for a day on API token billing (pay-per-turn) instead of the
  ChatGPT subscription it was supposed to use. The guard matches the
  Gemini side's existing `assertSubscriptionBilling()` env check, so
  neither bridge can silently switch to API billing.
  To recover: `codex logout && codex login` (browser-based ChatGPT
  sign-in), then `launchctl bootout`/`bootstrap` the appserver.

### Background — why a separate file

Codex CLI and Gemini CLI ship different agent protocols (Codex
app-server WebSocket vs Gemini ACP stdio). They can't share a single
protocol client without losing per-agent fidelity, so the bridge keeps
one client class per agent and shares the platform-side modules
(streaming consumer, Telegram surface, approval tracker, session map).
The naming is now slightly mismatched (`codex-tg-bridge` repo name vs
multi-agent reality) — kept as-is to avoid breaking the deployed
LaunchAgents until a v0.2 rename.

---

## [0.1.0] — 2026-05-15

Initial implementation + iterative debug shaping. All changes below
were made the same day during the bring-up of `@scout_Codex_bot` as the
first deployed instance. The five **audit invariants** at the top of
[README.md](./README.md) hold across every revision in this release.

### Added

- **Core bridge** (`src/server.ts`, `src/codex-client.ts`,
  `src/telegram-client.ts`, `src/session-map.ts`,
  `src/item-formatter.ts`) — Telegram ↔ codex app-server JSON-RPC
  bridge. ~600 LOC at landing.
- **Hermes-pattern streaming** (`src/turn-stream-consumer.ts`, 170 LOC) —
  one TurnStreamConsumer per agentMessage item, queue-based single-task
  drain, edit-throttle at 1 s with adaptive backoff up to 10 s on
  Telegram 429, fallback to send-once after 3 strikes. Ported from
  Hermes `gateway/stream_consumer.py`. Replaces the racy per-delta
  edit-spawn pattern that fragmented messages into one-char-per-TG
  blocks during the initial bring-up.
- **`item/*` formatter** — every codex ThreadItem type renders to a
  Telegram-readable block. Unknown types fall through to a generic
  dump so nothing is silently dropped (audit rule #4).
- **Persistent chat ↔ thread mapping** — `state/session-map.json`
  survives bridge restarts so conversations resume in the same codex
  thread until manually cleared.
- **Smoke test** (`scripts/smoke-test.ts`) — bypasses Telegram and
  verifies the codex side end-to-end. Asserts `model` from
  `~/.codex/config.toml`, `instructionSources` includes AGENTS.md,
  final agentMessage matches the prompt byte-for-byte.
- **LaunchAgent templates + installer** (`launchd/*.plist.template`,
  `launchd/install.sh`) — uses `@@USER@@`, `@@NAME@@`, `@@PORT@@`,
  `@@STATE_DIR@@` placeholder pattern (avoids the eager-substitution
  bug from the first installer revision that mangled
  `BRIDGE_STATE_DIR` into `BRIDGE_/Users/...`).
- **Final-flush guarantee on `TurnStreamConsumer.finish()`** — always
  runs one edit when `done` is set, even when no new content arrived
  since the previous flush, so the streaming cursor `" ▉"` is stripped
  on the final message.
- **Bidirectional JSON-RPC support in CodexClient** — recognizes
  server-to-client requests (frames carrying both `id` AND `method`),
  re-emits as `serverRequest` events with a `reply` callback that
  crafts the response by id. Previously these frames fell through to
  the error path and were silently dropped, causing codex to block
  forever when awaiting approval.
- **TG inline-keyboard approval flow** (`src/approval-tracker.ts`)  —
  codex approval requests
  (`item/commandExecution/requestApproval`,
  `item/fileChange/requestApproval`, `permissions/requestApproval`)
  render as Telegram messages with Accept / Accept-for-session /
  Decline buttons. The user's click resolves the pending JSON-RPC
  reply with their decision; codex resumes the turn.

### Fixed

- **Race on agentMessage deltas spawning duplicate TG messages.**
  The first revision's per-delta handler used
  `if (buffer) edit else await reply()`; because the `await reply()`
  doesn't resolve before the next delta fires, every delta took the
  "first delta" branch and spawned a new TG message. Each fragment was
  also racing into editMessageText and getting 429-rate-limited.
  Replaced with the single-consumer queue pattern (see above).
- **eager sed substitution in `launchd/install.sh`** mangled identifier
  fragments (`BRIDGE_STATE_DIR` → `BRIDGE_/Users/.../scout`) because
  `STATE_DIR` matched as a substring of `BRIDGE_STATE_DIR`. Replaced
  bare placeholders (`USER`, `PORT`, `STATE_DIR`) with sentinel form
  (`@@USER@@`, `@@PORT@@`, `@@STATE_DIR@@`) that cannot collide.

### Security / safety

- Bridge no longer auto-approves codex tool calls. All approvals route
  through the user via Telegram inline buttons. Fallback to `decline`
  for unknown methods, missing chat mapping, or send failures (fails
  closed).
- access.json honoured on both inbound text messages and callback_query
  clicks; only allowlisted user IDs can approve.

### Documentation

- `README.md` — architecture + 5 audit invariants + quick start + file
  map + known gaps.
- `SETUP.md` — first-time setup tutorial (Chinese): codex install,
  state-dir prep, LaunchAgent install, smoke test, e2e flow,
  troubleshooting.
- `CHANGELOG.md` — this file.
- LaunchAgent templates carry inline header comments explaining each
  substituted placeholder.

### Verified

- Smoke test (`bun scripts/smoke-test.ts`) end-to-end against live
  `codex app-server --listen ws://127.0.0.1:17651` on 2026-05-15.
- TG end-to-end against `@scout_Codex_bot`, including streaming UX
  (no fragmentation, cursor stripped on finish) and approval flow
  (codex sends `requestApproval`, button surfaces in Telegram, click
  routes back to codex).

### Known limitations (carried into 0.2.x)

- One thread per chat. Forum topics, group chats, and threaded replies
  are not handled separately.
- No attachment support (inbound or outbound).
- Bridge does not surface codex `pause`, `interrupt`, or `cancel`
  controls — to stop a turn the user has to wait for codex to finish.
- No timeout on pending approvals. If the user never clicks, the
  reply slot stays open until codex's own internal approval timeout
  fires (or never, depending on policy).
- LaunchAgent template paths assume macOS Apple Silicon
  (`/opt/homebrew/bin`, `/Users/<user>/.bun/bin`). Linux users need to
  edit `ProgramArguments` and `PATH`.

---

[0.1.0]: https://github.com/darwin7381/codex-tg-bridge/releases/tag/v0.1.0
