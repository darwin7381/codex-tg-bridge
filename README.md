# codex-tg-bridge

> **Zero-degradation** Telegram bridges for **OpenAI Codex** *and*
> **Google Gemini**. Forwards raw user text to the agent over its native
> protocol (Codex app-server WebSocket JSON-RPC for Codex; ACP stdio
> JSON-RPC for Gemini) and streams agent output back to Telegram
> unchanged. No prompt injection, no model overrides, no role reframing —
> each agent behaves byte-for-byte the same as when you type into its
> local CLI.

> Repo name says `codex-tg-bridge` but `src/gemini-server.ts` lives here
> too. Both bridges share the platform modules
> (`telegram-client.ts`, `session-map.ts`, `turn-stream-consumer.ts`)
> and differ only in the agent-protocol client.

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

Shared platform modules (work for both bridges):

| File | Purpose |
|---|---|
| `src/telegram-client.ts` | grammy bot with access.json allowlist + ackReaction + inline-keyboard helper. Subscribes to every grammy message type (text / photo / voice / audio / document / video / animation / sticker). Routes `callback_query` for approval clicks and ⛔ cancel clicks. Outbound helpers: reply (with long-message split), editMessage, react, sendWithButtons, sendPhoto, sendDocument, clearButtons. |
| `src/attachment-store.ts` | Downloads TG `file_id` files to `$STATE_DIR/inbox/`, hourly GC (7-day age cap, 1 GiB total). |
| `src/attachment-to-input.ts` | Maps `Attachment[]` to codex `UserInput[]` or ACP `ContentBlock[]` (image/audio base64, text-MIME inline, fall-through mentions). |
| `src/turn-stream-consumer.ts` | Streaming consumer ported from Hermes `gateway/stream_consumer.py`: queue + single-task drain, 1 s edit interval, adaptive backoff to 10 s on Telegram 429, fallback to one-shot send after 3 strikes. |
| `src/approval-tracker.ts` | Maps short `cbId` → pending JSON-RPC reply callbacks (codex's fixed-enum decision flow). |
| `src/session-map.ts` | Persistent chat_id → session/thread id mapping. |

Codex side:

| File | Purpose |
|---|---|
| `src/codex-client.ts` | WebSocket JSON-RPC client for `codex app-server`. Handles responses, notifications, **and** server-to-client requests (approval prompts). Audit rules #1/#2/#4. Boot-time guard refuses to start if `auth_mode=apikey` (subscription-only). |
| `src/item-formatter.ts` | Render every codex `ThreadItem` type to TG-friendly text. |
| `src/server.ts` | Codex bridge daemon (entry: `bun start`). |
| `scripts/smoke-test.ts` | TG-bypass smoke test against `codex app-server`. |

Gemini side:

| File | Purpose |
|---|---|
| `src/gemini-client.ts` | Stdio NDJSON JSON-RPC client for `gemini --acp`. Spawns gemini as a subprocess and speaks ACP (Agent Client Protocol). Boot-time guard refuses to start if `*_API_KEY` envs are set (subscription-only). |
| `src/acp-item-formatter.ts` | Render ACP `session/update` payloads (plan / tool_call / tool_call_update / etc.) to TG-friendly text. |
| `src/gemini-server.ts` | Gemini bridge daemon (entry: `bun start-gemini`). Dynamic inline-keyboard approvals — buttons reflect agent-supplied option list per request. |
| `scripts/smoke-test-gemini.ts` | TG-bypass smoke test against `gemini --acp`. |
| `launchd/*.plist.template` | LaunchAgent templates (run via `install.sh`). |
| `launchd/install.sh` | Substitute `USER` / `NAME` / `PORT` / `STATE_DIR` and write plists. |

## Capabilities (see [CHANGELOG.md](./CHANGELOG.md) for full history)

- ✅ Two bridges in one repo — Telegram ↔ codex app-server and
  Telegram ↔ gemini ACP. Both honour the five audit invariants in
  code at the protocol boundary.
- ✅ Real-time streaming (Hermes-pattern consumer: 1 s edit interval,
  adaptive backoff to 10 s on Telegram 429, fallback to one-shot after
  3 strikes).
- ✅ **Inbound multimedia**: photo / voice / audio / document / video
  / animation / sticker — downloaded to `$STATE_DIR/inbox/` and
  mapped into each agent's native input shape. Image works on both
  sides; audio works natively on gemini; codex side renders audio as
  a `Bash whisper …` hint for the agent to transcribe itself.
- ✅ **Outbound multimedia (codex)**: `imageGeneration` and image /
  PDF / archive / audio / video `fileChange` outputs are auto-sent
  back to TG as photos or documents alongside the agent's text
  reply.
- ✅ Inline-keyboard **approval flow**: codex `requestApproval`
  prompts (command / fileChange / permissions) and gemini
  `session/request_permission` (dynamic agent-supplied options)
  both surface as Telegram inline buttons. Default fail-closed if the
  prompt can't be delivered.
- ✅ ⛔ **Cancel button** on every turn — click to interrupt codex
  (`turn/interrupt`) or gemini (`session/cancel`).
- ✅ Long-message split with `[i/n]` continuation markers.
- ✅ Persistent chat ↔ session/thread mapping survives restart.
- ✅ Hourly GC of the attachment inbox (7-day age cap, 1 GiB total).
- ✅ Subscription-billing guards on both sides — codex
  (`auth_mode != apikey`) and gemini (no `*_API_KEY` env). Fail-fast
  at boot.
- ✅ Smoke tests that prove each agent side honours its own config
  and round-trips the prompt verbatim.

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
