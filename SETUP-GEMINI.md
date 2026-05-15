# gemini-tg-bridge — 完整 Setup 教學（中文）

> 從零搭一隻 Telegram bot 透過 `gemini-tg-bridge` 接 Google Gemini CLI，**零降智**且**走 Gemini 訂閱（不是 API 計費）**。涵蓋 gemini-cli 安裝、Google OAuth 登入、TG bot 設定、launchd daemon、健康檢查、e2e 測試、排錯。

如果你已經跑過 codex 版的 SETUP，這份只列**不同的部分**。

---

## 0. Gemini 版跟 Codex 版差在哪

| 面向 | codex 版 | gemini 版 |
|---|---|---|
| Agent 端 protocol | Codex app-server WebSocket (JSON-RPC 2.0 over WS) | **ACP** (Agent Client Protocol, JSON-RPC 2.0 over stdio NDJSON) |
| Agent 啟動方式 | `codex app-server --listen ws://127.0.0.1:PORT` 獨立 daemon | `gemini --acp` 被 bridge 啟動成 stdio subprocess |
| LaunchAgent 數量 | **2 份**（appserver + bridge） | **1 份**（bridge 自己生 subprocess） |
| Approval 設計 | 固定 enum (`accept` / `acceptForSession` / `decline`) | 動態 options 由 agent 端提供，每次數量/名稱可變 |
| 訂閱 vs API guard | `assertSubscriptionAuth()` — 檢查 `~/.codex/auth.json` 沒有 `auth_mode: apikey` | `assertSubscriptionBilling()` — 檢查 env **沒有** `*_API_KEY` / `*_USE_VERTEXAI` |

---

## 1. 前置需求

| 工具 | 安裝 |
|---|---|
| macOS | — |
| Node.js 22+ | brew install node |
| **gemini-cli** | `npm install -g @google/gemini-cli`（v0.34.0+ 才有 `--acp`） |
| [Bun](https://bun.sh/) | `curl -fsSL https://bun.sh/install \| bash` |
| Telegram bot token | DM [@BotFather](https://t.me/BotFather) → `/newbot` |
| Joey 的 Telegram numeric user ID | [@userinfobot](https://t.me/userinfobot) |

驗證：
```bash
gemini --version    # 預期 0.34.0+
gemini --help | grep -E 'acp'
# 應該看到：--acp  Starts the agent in ACP mode
```

---

## 2. ⚠️ Google OAuth 登入（**不要 API key**）

```bash
gemini auth          # 開瀏覽器，登入 Google 帳號（用有 Gemini Advanced 訂閱的那個）
```

**驗證**（很重要 — 走錯就會吃 API 計費）：
```bash
# (1) 確認 oauth_creds.json 存在
ls ~/.gemini/oauth_creds.json
ls ~/.gemini/google_accounts.json

# (2) 確認 shell env 沒有任何 *_API_KEY 殘留
env | grep -iE 'GEMINI_API_KEY|GOOGLE_API_KEY|GOOGLE_GENAI_USE_VERTEXAI'
# 期待輸出：**空白**

# (3) 確認 ~/.zshrc / ~/.bashrc / launchctl setenv 也沒有
grep -rE 'GEMINI_API_KEY|GOOGLE_API_KEY|GOOGLE_GENAI_USE_VERTEXAI' ~/.zshrc ~/.bashrc 2>/dev/null
launchctl getenv GEMINI_API_KEY
launchctl getenv GOOGLE_API_KEY
launchctl getenv GOOGLE_GENAI_USE_VERTEXAI
```

如果 (2) 或 (3) 有任何輸出 → 必須清掉，否則 gemini-cli 會**靜默切到** AI Studio API 計費，每月可能爆 $100+。

**Bridge 啟動時會自動檢查**：`src/gemini-client.ts:assertSubscriptionBilling()` 如果 env 有 `*_API_KEY` 直接 exit 1，不會 spawn gemini。

---

## 3. Smoke test — 確認 gemini --acp 在你環境跑得起

```bash
cd ~/codex-tg-bridge
bun scripts/smoke-test-gemini.ts "Reply with exactly: pong"
```

期待輸出：
```
spawned gemini --acp
initialize → gemini-cli v0.34.0, authMethods=oauth-personal,gemini-api-key,vertex-ai,gateway
session/new → sessionId=<uuid>
listening for session/update during turn ("Reply with exactly: pong"):
  ← session/update: available_commands_update
.
✓ session/prompt completed in 3900ms — stopReason=end_turn
```

**Audit checklist**：
- [ ] `authMethods` 列表第一個是 `oauth-personal`（你登入用的）
- [ ] `session/new` 成功（沒有 `permission denied` / `cwd missing` 之類 error）
- [ ] 最後 `stopReason=end_turn`（正常結束，不是 `refusal` 或 `max_tokens`）

---

## 4. 設定 bot（state dir）

```bash
NAME=scout                                       # 你的 bot 別名（gemini-scout 不重複用）
STATE_DIR=~/.codex-tg-bridge/state/gemini-$NAME
mkdir -p $STATE_DIR

# Bot token
echo "TELEGRAM_BOT_TOKEN=<from @BotFather>" > $STATE_DIR/.env
chmod 600 $STATE_DIR/.env

# Access policy
cat > $STATE_DIR/access.json <<EOF
{
  "dmPolicy": "approved-only",
  "ackReaction": "👀",
  "approved": [
    { "user_id": "<your TG user id>", "username": "..." }
  ]
}
EOF
chmod 600 $STATE_DIR/access.json
```

---

## 5. Install + bootstrap LaunchAgent

```bash
NAME=gemini-scout                                  # 給 plist 用的識別
STATE_DIR=~/.codex-tg-bridge/state/$NAME
USERNAME=$(whoami)
PLIST=~/Library/LaunchAgents/com.btai.gemini-tg-bridge.$NAME.plist

sed -e "s|@@NAME@@|$NAME|g" \
    -e "s|@@USER@@|$USERNAME|g" \
    -e "s|@@STATE_DIR@@|$STATE_DIR|g" \
    ~/codex-tg-bridge/launchd/com.btai.gemini-tg-bridge.scout.plist.template \
  > "$PLIST"

launchctl bootstrap gui/$(id -u) "$PLIST"
```

驗證：
```bash
launchctl list | grep gemini-tg-bridge
tail -20 $STATE_DIR/launchd.out.log
```

期待 bridge log：
```
[info] boot: STATE_DIR=... GEMINI=/opt/homebrew/bin/gemini DEFAULT_CWD=(client.process.cwd)
[info] gemini ready: gemini-cli v0.34.0, capabilities={loadSession, ...}
[info] telegram bot connected as @<your bot username>
[info] telegram polling ready
```

---

## 6. End-to-end 測試

DM bot 一句「hi」：
1. Bot 加 👀 reaction
2. Bridge log 看到 `→ TG msg from chat=...`
3. `session/new` + `session/prompt`
4. 你 TG 收到 streaming reply（cursor `▉` 過程中可見，結束時消失）
5. Bridge log 看到 `stopReason=end_turn`

第二則訊息 **resume 同 session**（chat_id → sessionId 持久化在 `$STATE_DIR/session-map.json`）。

⚠️ **session resume 限制**：gemini-cli ACP 的 session 是 in-process state。Bridge 重啟（kill + 重 spawn `gemini --acp`）之後舊 sessionId 失效。第一則 TG msg 會嘗試 `session/load`，失敗則自動 fallback 到 `session/new` 開新 session。要強制 fresh thread → 刪 `$STATE_DIR/session-map.json`。

---

## 7. Approval flow（動態 options）

Gemini ACP 的 approval 設計跟 codex 不同：
- Codex：固定 enum (`accept` / `acceptForSession` / `decline`）
- **Gemini**：agent 給一個 `options` 陣列（每個 option 有 `optionId` + `name`），bridge 把整個 list render 成 TG 按鈕

例如 gemini 想跑 `cat ~/.zshrc`，TG 會收到：
```
🛂 gemini wants permission for read: cat ~/.zshrc
```
[每個 option 一顆按鈕，名稱由 agent 給]

點按鈕 → bridge 把 optionId 回 `session/request_permission`。

---

## 8. Troubleshooting

### 8.1 Bridge exit 1, log 印 `Refusing to start gemini --acp`
→ env 殘留 `*_API_KEY`。用 §2 的命令找出來清掉。Bridge 不會誤用 API。

### 8.2 `session/new` 報 `cwd required`
舊版本沒帶 cwd。新版 `gemini-client.ts:sessionNew` 已 default 到 `process.cwd()`。

### 8.3 `gemini auth` 開瀏覽器但沒辦法 callback
- 確認 firewall 沒擋 localhost
- 或用 `gemini auth --no-browser` 改 manual code flow

### 8.4 訊息沒回應
```bash
tail -50 $STATE_DIR/launchd.out.log | grep -v 'agent_thought'
```
看 `← gemini: method=...` 流向。如果 `session/prompt` 進去但沒回 → 看 gemini --acp stderr (`launchd.err.log` 或 bridge log 的 `[gemini stderr]` 行）。

### 8.5 想換 model / 參數
**不要在 bridge 改**。改 `~/.gemini/settings.json`（或環境變數 `GEMINI_MODEL` 之類，gemini-cli 自己讀）。然後重啟 bridge（§9）。

---

## 9. 重啟 / Reload

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.btai.gemini-tg-bridge.<NAME>.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.btai.gemini-tg-bridge.<NAME>.plist
```

`KeepAlive=true`，crash 會自動重啟。

---

## 10. References

- 本 bridge code：`~/codex-tg-bridge/`（git: github.com/darwin7381/codex-tg-bridge）
- Gemini ACP 官方 spec：https://agentclientprotocol.com
- Gemini CLI docs：https://geminicli.com/docs/
- $150 trap 故事：https://medium.com/@lhc1990/the-150-gemini-cli-trap
- Codex 版 SETUP：[SETUP.md](./SETUP.md)
