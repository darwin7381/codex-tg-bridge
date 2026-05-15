# Changelog

All notable changes to this project. Versions follow [SemVer](https://semver.org/).

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
