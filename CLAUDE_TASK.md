# 需求：修復 codex-tg-bridge，全面支援 Gemini CLI 的特有互動與進階功能

目前 `codex-tg-bridge` (包含 `gemini-tg-bridge`) 已經能運作基本的 Agent Control Protocol (ACP)，但為了達到真正的「Zero-degradation (零降智)」體驗，我們需要補足 Gemini CLI 獨有且複雜的互動模式。

我已經透過系統內部工具深度調查了 Gemini CLI 的 ACP 底層通訊與特殊機制，發現有許多橋接器尚未支援的盲區。請參考以下需求清單，幫我修改 `src/gemini-server.ts`, `src/acp-item-formatter.ts`, `src/attachment-to-input.ts` 等模組：

## 1. 完整支援 `ask_user` 與 `exit_plan_mode` (修復卡死 Bug)
*   **問題：** `gemini-server.ts` 目前攔截 `session/request_permission` 時，強制要求 `options` 陣列不可為空 (`options.length === 0` 會直接 cancelled)。但 Gemini 的 `ask_user` (文字題) 或 `exit_plan_mode` 往往沒有 options，導致 Agent 卡死。
*   **修改目標：** 
    放寬解析邏輯，並根據不同的請求情境做出對應處理：
    1. **Choice (選擇題 / Multi-select)：** 若有選項，轉換為 Telegram InlineKeyboard。請注意 Gemini 的 `ask_user` 可能支援多選 (`multiSelect`)，需要盡可能對應 TG 的按鈕互動。
    2. **Yes/No 或 Boolean (如 exit_plan_mode)：** 產生 `[同意 (Approve)]` 與 `[拒絕並附帶意見 (Reject with feedback)]` 的按鈕。
    3. **Text (等待文字輸入)：** 在全域狀態中標記該 `chatId` 正在「等待文字輸入」。當 Telegram 收到 `tg.on('message')` 且處於此狀態時，**攔截該則訊息**，將其包裝成對應的 outcome 回傳 (例如 `{ outcome: { outcome: 'approved', input: m.text } }`)，不要當作新的 Prompt 送出。

## 2. 實作任務與待辦事項追蹤 (`write_todos`)
*   **問題：** Gemini CLI 頻繁使用 `write_todos` 工具來維護子任務清單，但目前在 Telegram 上沒有直觀的呈現。
*   **修改目標：** 在 `acp-item-formatter.ts` 中攔截 `write_todos` 的 `tool_call`，解析其參數 (清單內容與狀態)，並使用 Checkbox 符號 (如 ☑️ / 🔲) 在 Telegram 訊息中漂亮地渲染出 Agent 目前的任務進度。

## 3. 檔案變更與 IDE 級別的 Context 渲染 (`openDiff` / `write_file`)
*   **問題：** 當 Agent 呼叫修改檔案的 mutator tools (`write_file`, `replace`, `run_shell_command`) 時，目前只顯示名稱，使用者很難判斷是否該按下「Approve」。
*   **修改目標：** 在 `gemini-server.ts` 產生 approval 提示時，或是 `acp-item-formatter.ts` 渲染 `tool_call` 時，盡可能提取並顯示變更的**具體內容** (例如: 要執行的 shell command 完整指令、要修改的程式碼片段或 Diff 摘要)，讓使用者能在 Telegram 內安心點擊批准。

## 4. 多媒體與附件支援 Parity (Inbound & Outbound)
*   **Inbound (`src/attachment-to-input.ts`)：** 請確保 Telegram 傳來的照片、語音等多媒體檔案，能正確映射為 Gemini ACP 支援的 `ContentBlock[]` 格式 (例如 `image/jpeg` 加上 base64 payload)，讓 Gemini 能分析圖片與音音。
*   **Outbound：** 類似 Codex 端會自動將生成的圖片或檔案回傳，請嘗試在 Gemini 端偵測 `fileChange` 或 `write_file` 產生的媒體檔案，作為 Telegram Photo/Document 傳回。

## 5. 強化專屬視覺渲染與 Slash Command 攔截
*   **UI 渲染 (`formatAcpUpdate`)：** 增加 Gemini 特有工具的 Emoji 辨識，例如 `enter_plan_mode` (🎯)、`google_web_search` (🌐)、`codebase_investigator` (🕵️)、`activate_skill` (⚡)、`save_memory` (🧠)、`generalist` (🤖)。
*   **Slash Command 路由：** 在 `gemini-server.ts` 的 `tg.on('message')` 攔截 Telegram 指令 (如 `/plan`, `/resume`, `/tools`)，並將其正確映射為 Gemini 的控制命令或系統操作，而不只是一般的文字 prompt。

請幫我實作以上 5 大核心需求，徹底補足 Gemini 獨有功能的橋接，讓這套系統完美發揮！