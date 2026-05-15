# codex-tg-bridge — 完整 Setup 教學（中文）

> 從零搭一隻 Telegram bot 透過 `codex-tg-bridge` 接 OpenAI Codex CLI，**零降智**。涵蓋 codex 安裝、token 設定、access policy、launchd daemon、健康檢查、e2e 測試、排錯。

---

## 0. 為何用這個 bridge 而不是 cc-connect / Ductor / TeleCodex

[完整 vs 比對請看 incident report](https://md.blocktempo.ai/TFkYzCibQheCDaV2fyoaBg)，TL;DR：

- **cc-connect / Ductor**：wrap CLI + append system prompt + stream-json IO → 結構性降智，跟 vanilla CLI 行為**已實測有差**（[投稿者自己的調查](https://md.blocktempo.ai/FW453HM5Sl208DDq3KqqOg)）
- **TeleCodex**：用 `@openai/codex-sdk` 包 CLI subprocess。SDK 是官方但多一層間接，沒實測證明 0%降智
- **openclaw-codex-app-server**：架構對（用 app-server protocol），但沒 audit 過 source 確認 0%降智
- **本 bridge**：明確列 5 條 audit invariant + 在 code 裡 enforce + 有 smoke test 驗證。直接走 Codex 官方 app-server WebSocket protocol，agent core 跟 `codex` CLI 共用 `codex-rs/core/`

## 1. 前置需求

| 工具 | 安裝 |
|---|---|
| macOS | — |
| Node.js 18+ | brew install node |
| OpenAI Codex CLI | `npm install -g @openai/codex` |
| [Bun](https://bun.sh/) | `curl -fsSL https://bun.sh/install \| bash` |
| Telegram bot token | DM [@BotFather](https://t.me/BotFather) → `/newbot` |
| 你的 Telegram numeric user ID | DM [@userinfobot](https://t.me/userinfobot) |
| launchd（macOS）/ systemd（Linux） | 系統內建 |

Codex 必須**已經 `codex login`** 登入 ChatGPT 訂閱（或設好 API key）。本 bridge 不處理 Codex 認證。

驗證：
```bash
codex --version    # 預期 0.130.0 或更新
codex app-server --help | head -5
```

## 2. 取得 bridge code

```bash
git clone <repo> ~/codex-tg-bridge
cd ~/codex-tg-bridge
bun install                    # 大約 5 秒
bun tsc --noEmit               # typecheck（無輸出 = 乾淨）
```

## 3. Smoke test — 確認 codex 側不降智

**這步在綁 TG 之前就能跑**。目的是直接驗證 audit rule 1-2-4 在你環境有效：

Terminal A：
```bash
codex app-server --listen ws://127.0.0.1:17651
```

Terminal B：
```bash
cd ~/codex-tg-bridge
bun scripts/smoke-test.ts "Reply with exactly: hello"
```

期待輸出：
```
connected to ws://127.0.0.1:17651
initialize → userAgent="..." codexHome=/Users/.../.codex macos
thread/start → id=<uuid> model=gpt-5.5 cwd=<your cwd>
instructionSources: ["/Users/.../.codex/AGENTS.md", ".../AGENTS.md"]

listening for notifications during turn ("Reply with exactly: hello"):
  ← thread/started
  ← mcpServer/startupStatus/updated  ...
  ← item/started
  ← item/completed type=userMessage
  ← item/started
  ← item/completed type=reasoning
  ← item/started
  ← item/agentMessage/delta ......
  ← item/completed type=agentMessage: hello
  ← turn/completed

✓ turn/completed received — codex side works end-to-end.
```

**Audit checklist**（每條都要 ✓）：
- [ ] `model` 顯示的是你 `~/.codex/config.toml` 設的值（沒被 override 成 default）
- [ ] `instructionSources` 包含你的 `AGENTS.md` files
- [ ] Final agentMessage 內容**完全等於**你 prompt 要求的（沒被 bridge 改寫）
- [ ] `reasoning` 跟 `userMessage` 等 item type 都有出現（沒被過濾）

任何一條失敗 = 有降智，要 debug 才能繼續。

Cleanup：
```bash
pkill -f 'codex app-server.*17651'
```

## 4. 設定 bot（state dir）

每隻 bot 一個 STATE_DIR：

```bash
NAME=scout                                       # 你的 bot 別名
PORT=17651                                        # codex app-server 用的 port
STATE_DIR=~/.codex-tg-bridge/state/$NAME
mkdir -p $STATE_DIR ~/.codex-tg-bridge/logs

# Bot token
echo "TELEGRAM_BOT_TOKEN=123456789:AAH..." > $STATE_DIR/.env
chmod 600 $STATE_DIR/.env

# Access policy
cat > $STATE_DIR/access.json <<EOF
{
  "dmPolicy": "approved-only",
  "ackReaction": "👀",
  "approved": [
    { "user_id": "1828173984", "username": "Advac777" }
  ]
}
EOF
chmod 600 $STATE_DIR/access.json
```

### 4.1 dmPolicy 選項

- `"approved-only"`（推薦）— 只 approved list 裡的 user_id 能 DM
- `"open"` — 任何人都能 DM（**spam 風險高**）
- `"pairing"` — 暫未實作 pairing flow（本 bridge 是 single-user，不需要）

### 4.2 ackReaction 原則

bot 收到訊息**瞬間**會在你訊息上加這個 emoji，給「收到了」即時訊號。Telegram 只接受 whitelist emoji（`👀 🫡 💯 ✅ 🤔 ❌ 🔥` 等都 OK）。

設 `"👀"` 是 convention：跟你既有的 telegram-http plugin 一致，後續 Claude 出來的「執行中 / 完成 / 失敗」reaction 可以挑不同 emoji 不重複。

## 5. Install + bootstrap LaunchAgents

```bash
cd ~/codex-tg-bridge
./launchd/install.sh $NAME $PORT $STATE_DIR
```

這會：
1. 把 `launchd/*.plist.template` 的 `USER` / `NAME` / `PORT` / `STATE_DIR` 占位符替換成你的值
2. 寫到 `~/Library/LaunchAgents/com.btai.codex-appserver.$NAME.plist` + `com.btai.codex-tg-bridge.$NAME.plist`

接著 bootstrap（**順序很重要 — appserver 先**）：

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.btai.codex-appserver.$NAME.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.btai.codex-tg-bridge.$NAME.plist
```

驗證：
```bash
# codex app-server LISTEN
lsof -nP -i :$PORT | head -3

# codex 健康
curl -s http://127.0.0.1:$PORT/healthz
# 預期：{"ok":true...} 或 200

# bridge log（持續 tail）
tail -f $STATE_DIR/launchd.out.log
```

Bridge log 應該看到：
```
[info] boot: STATE_DIR=... CODEX_URL=ws://127.0.0.1:17651
[info] connected to codex app-server at ws://127.0.0.1:17651
[info] codex says: userAgent="..." codexHome=... platform=macos
[info] telegram bot connected as @your_bot_username
[info] telegram polling ready
```

## 6. End-to-end 測試

從你 Telegram 帳號 DM bot：

1. 傳「hi」
2. Bot 立刻加 👀 reaction
3. Bridge log 看到 `→ TG msg from chat=... user=Advac777: hi`
4. 然後 `thread/start` + `turn/start`
5. Codex 跑 agent loop（reasoning + agentMessage）
6. 你 Telegram 收到 codex 的 reply
7. Bridge log 看到 `← turn/completed`

第二則訊息會 **resume 同 thread**（chat_id → thread_id 對應持久化在 `$STATE_DIR/session-map.json`），對話有記憶。

## 7. 多 bot 操作（multiple instances）

每隻 bot 一份 `STATE_DIR` + 一個 `PORT`：

```bash
./launchd/install.sh scout    17651 ~/.codex-tg-bridge/state/scout
./launchd/install.sh research 17652 ~/.codex-tg-bridge/state/research
./launchd/install.sh video    17653 ~/.codex-tg-bridge/state/video
```

每個 instance 都跑獨立的 `codex app-server`（其實是 4 個 daemon = appserver × 2 + bridge × 2 各兩個 bot），各自有 thread / session。

## 8. Troubleshooting

### 8.1 Bridge 起不來，log 顯示 `not connected` 或 `econnrefused`

→ codex app-server 還沒起 / 起來但 crash 了。
```bash
launchctl list | grep codex-appserver
tail -50 ~/.codex-tg-bridge/logs/codex-appserver-$NAME.err.log
```

### 8.2 `codex login` 還沒做

App-server 起得來但 thread/start 會回錯。先到 terminal 跑 `codex login` 完成 ChatGPT 訂閱 / API key 設定再回來。

### 8.3 訊息沒回應

依序檢查：
1. `tail $STATE_DIR/launchd.out.log | grep '→ TG'` — 看 TG 訊息有沒有進來
2. `tail | grep 'turn/start'` — 看有沒有 forward 到 codex
3. `tail | grep 'turn/completed'` — 看 codex 有沒有跑完
4. 如果 (1) 沒有 → access.json 的 `approved` 是否含你 user_id？
5. 如果 (2) 沒有 → bridge 跟 codex app-server 的連線斷了？`lsof -nP -i :$PORT`
6. 如果 (3) 沒有 → codex 卡在 approval / 出錯。看 codex-appserver 的 err log

### 8.4 想換 Codex model / personality

**不要在 bridge 改**。改 `~/.codex/config.toml`：
```toml
model = "gpt-5.5"
personality = "pragmatic"
model_reasoning_effort = "high"
```

然後重啟 codex app-server：
```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.btai.codex-appserver.$NAME.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.btai.codex-appserver.$NAME.plist
```

下次 `thread/start` 會用新設定。Bridge 不用動（這是 audit rule #5 的好處 — 單一 config source）。

### 8.5 想清掉某個 chat 的 thread（fresh start）

刪 `$STATE_DIR/session-map.json` 對應的 key，或整個檔案。下次 TG 訊息會 `thread/start` 新的。

## 9. 升級 / 維運

- **升級 codex CLI**：`npm install -g @openai/codex@latest` → reload app-server LaunchAgent
- **升級 bridge code**：`cd ~/codex-tg-bridge && git pull && bun install` → reload bridge LaunchAgent
- **看 daemon 健康**：每個 codex-appserver 有 `/healthz` 跟 `/readyz`，可以包進 supervisor probe
- **rotate session**：若 codex 抱怨 context window 滿了，刪 session-map.json 對應 key

## 10. 卸載

```bash
NAME=scout
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.btai.codex-tg-bridge.$NAME.plist
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.btai.codex-appserver.$NAME.plist
rm ~/Library/LaunchAgents/com.btai.codex-{appserver,tg-bridge}.$NAME.plist
rm -rf ~/.codex-tg-bridge/state/$NAME
```

## 11. References

- Bridge code：`~/codex-tg-bridge/`
- Codex 官方 docs：[App Server](https://developers.openai.com/codex/app-server)
- Codex source（agent core 共用）：[openai/codex codex-rs/core](https://github.com/openai/codex/tree/main/codex-rs/core)
- cc-bridge 降智調查（為何要這個 bridge）：[HedgeDoc](https://md.blocktempo.ai/FW453HM5Sl208DDq3KqqOg)
- Memory：`project_channels_disable_picker_tools.md`、`project_plugin_url_dedup.md`、`project_claude_2141_transport_regression.md`
