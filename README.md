# codex-tg-bridge

> **Zero-degradation** Telegram ↔ OpenAI Codex bridge. Forwards raw user text
> to `codex app-server` over JSON-RPC/WebSocket and streams `item/*`
> notifications back to Telegram unchanged. No prompt injection, no model
> overrides, no role reframing — Codex behaves byte-for-byte the same as
> when you type into the local CLI.

---

## Why

`cc-connect` and similar messaging-bridge tools wrap the local CLI with
`--append-system-prompt`, `--permission-mode acceptEdits`, stream-json IO,
and an "always resume" pattern. Even on the same model, this is observably
"dumber" than the vanilla CLI — see the [cc-bridge 結構性降智 investigation](https://md.blocktempo.ai/FW453HM5Sl208DDq3KqqOg).

This bridge takes the opposite approach: **use OpenAI's official Codex
app-server protocol** (the same one the Codex VS Code extension uses) and
forward raw user input as-is. No wrapper layer between the user and the
agent.

The agent core (`codex-rs/core/`) is shared across the CLI, exec mode, and
app-server transports, so behaviour is identical at the model boundary.

## Five audit invariants (enforced in code)

1. **`thread/start` sends no overrides** — no `baseInstructions`,
   `developerInstructions`, `personality`, `model`, `approvalPolicy`,
   `sandbox`. Codex reads `~/.codex/config.toml` and `AGENTS.md` itself.
   (`src/codex-client.ts:threadStart`)
2. **`turn/start` sends only `threadId` + `input`.** No per-turn model /
   personality / effort / cwd / sandbox override.
   (`src/codex-client.ts:turnStart`)
3. **User TG message → `turn/start` input is byte-for-byte the raw text.**
   No prefix / suffix / wrapping. (`src/server.ts:tg.on('message')`)
4. **Every `item/*` notification is forwarded.** Unknown item types
   render to a generic dump — nothing is silently dropped.
   (`src/item-formatter.ts`)
5. **`~/.codex/config.toml` is the single source of config truth.** The
   bridge passes no config — Codex reads it itself each thread/turn.

## Architecture

```
   Telegram long-poll
            │
            ▼
   [codex-tg-bridge daemon]              src/{server,telegram-client,codex-client}.ts
   - grammy bot (TG)                     ~250 lines of TS
   - ws JSON-RPC client (codex)
            │
            ▼   ws://127.0.0.1:PORT
   [codex app-server]                    `codex app-server --listen ws://...`
   - JSON-RPC 2.0 over WebSocket          official OpenAI binary
            │
            ▼
   codex-rs/core/                         same agent core as `codex` CLI
```

Both processes run as separate LaunchAgents. The bridge fails fast if the
app-server isn't up; the app-server is independent of the bridge.

## Quick start

```bash
# 1. Install codex CLI (provides the app-server) + bun
npm install -g @openai/codex
curl -fsSL https://bun.sh/install | bash

# 2. Clone this repo + install deps
git clone <repo> ~/codex-tg-bridge && cd ~/codex-tg-bridge && bun install

# 3. Prepare state dir for one bot
NAME=scout                                           # or research / video / etc.
PORT=17651                                            # one per codex instance
STATE_DIR=~/.codex-tg-bridge/state/$NAME
mkdir -p $STATE_DIR

echo "TELEGRAM_BOT_TOKEN=<from @BotFather>" > $STATE_DIR/.env
chmod 600 $STATE_DIR/.env

cat > $STATE_DIR/access.json <<EOF
{
  "dmPolicy": "approved-only",
  "ackReaction": "👀",
  "approved": [{ "user_id": "<your TG user id from @userinfobot>" }]
}
EOF

# 4. Install + bootstrap LaunchAgents (codex app-server + bridge)
./launchd/install.sh $NAME $PORT $STATE_DIR
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.btai.codex-appserver.$NAME.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.btai.codex-tg-bridge.$NAME.plist

# 5. Verify
lsof -i :$PORT | head -3                              # codex app-server LISTEN
curl http://127.0.0.1:$PORT/healthz                   # codex healthz
tail -f $STATE_DIR/launchd.out.log                    # bridge log

# 6. DM your bot from Telegram. You should see your message appear in
#    the bridge log, then codex respond, with full tool/reasoning/plan
#    items streamed back to your TG chat.
```

## Verification: smoke test the codex side alone

Before wiring up Telegram, you can verify the bridge's Codex client works:

```bash
# Terminal 1
codex app-server --listen ws://127.0.0.1:17651

# Terminal 2
cd ~/codex-tg-bridge
bun scripts/smoke-test.ts "Reply with exactly: hello"
```

Expected output:
```
connected to ws://127.0.0.1:17651
initialize → userAgent="..." codexHome=/Users/.../.codex macos
thread/start → id=... model=gpt-5.5 cwd=...
instructionSources: ["/.../AGENTS.md", ...]
...
  ← item/completed type=agentMessage: hello
  ← turn/completed
✓ turn/completed received — codex side works end-to-end.
```

If `model` matches your `~/.codex/config.toml`, `instructionSources` lists
your `AGENTS.md` files, and the final agentMessage matches the prompt
verbatim, the zero-degradation invariants are intact.

## File map

| File | Purpose |
|---|---|
| `src/codex-client.ts` | WebSocket JSON-RPC client; handles responses, notifications, **and** server-to-client requests (e.g. approval prompts). Audit rules #1/#2/#4. |
| `src/telegram-client.ts` | grammy bot with access.json allowlist + ackReaction + inline-keyboard helper + `callback_query` handler for approval clicks. |
| `src/turn-stream-consumer.ts` | Per-agentMessage streaming consumer ported from Hermes `gateway/stream_consumer.py`: queue + single-task drain, 1 s edit interval, adaptive backoff to 10 s on Telegram 429, fallback to one-shot send after 3 strikes. |
| `src/approval-tracker.ts` | Maps short `cbId` → pending JSON-RPC reply callbacks. User's button click resolves the approval. |
| `src/item-formatter.ts` | Render every `ThreadItem` type to a TG-friendly string. |
| `src/session-map.ts` | Persistent chat_id → thread_id mapping. |
| `src/server.ts` | Bridge daemon orchestrating all of the above. |
| `scripts/smoke-test.ts` | Bypasses TG; verifies codex side end-to-end. |
| `launchd/*.plist.template` | LaunchAgent templates (run via `install.sh`). |
| `launchd/install.sh` | Substitute `USER` / `NAME` / `PORT` / `STATE_DIR` and write plists. |

## Capabilities (as of 0.1.0 — see [CHANGELOG.md](./CHANGELOG.md))

- ✅ Telegram ↔ codex app-server JSON-RPC bridge with five audit
  invariants enforced in code.
- ✅ Real-time streaming of `agentMessage` deltas (Hermes-pattern
  consumer, 1 s edit interval, adaptive backoff).
- ✅ Other `item/*` types (commandExecution, fileChange, reasoning,
  mcpToolCall, plan, etc.) render via formatter and post as separate
  TG messages.
- ✅ Persistent chat ↔ thread mapping (`state/session-map.json`),
  resumes after restart.
- ✅ Inline-keyboard **approval flow**: codex `requestApproval`
  prompts (command exec / file change / permissions) surface in
  Telegram with Accept / Accept-for-session / Decline buttons.
- ✅ Smoke test that proves codex side honours `~/.codex/config.toml`
  and AGENTS.md and round-trips the user prompt verbatim.

## Limitations / known gaps

- **One thread per TG chat.** Forum topics, threaded replies, and group
  chats are not yet supported.
- **No attachments.** Inbound: text only. Outbound: text only.
- **No interrupt/cancel control** for a running turn from the chat
  side. The user has to wait for codex to finish.
- **No timeout on pending approvals.** If you never click a button,
  the JSON-RPC reply slot stays open until codex's own internal
  approval timeout (if any) fires.
- **Single-user.** Designed for personal use; multi-user with isolation
  would need per-user state dirs and a more elaborate access model.

## License

Apache-2.0.
