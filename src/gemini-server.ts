/**
 * gemini-tg-bridge entry point — parallel to src/server.ts (codex side).
 *
 * Spawns `gemini --acp` as a stdio subprocess, wires its ACP JSON-RPC
 * stream to a Telegram bot. Reuses the same supporting modules as the
 * codex bridge: TelegramClient, SessionMap, TurnStreamConsumer (for
 * agent_message_chunk streaming), and a new ACP-aware approval tracker.
 *
 * The five audit invariants are enforced in src/gemini-client.ts at
 * the protocol boundary; this file just wires events.
 *
 * Env:
 *   TELEGRAM_BOT_TOKEN   bot token (also read from $STATE_DIR/.env)
 *   BRIDGE_STATE_DIR     where access.json + session-map.json live
 *   BRIDGE_DEFAULT_CWD   optional cwd passed to session/new
 *   GEMINI_BINARY        path to gemini (default: /opt/homebrew/bin/gemini)
 *
 * IMPORTANT: GEMINI_API_KEY / GOOGLE_API_KEY / GOOGLE_GENAI_USE_VERTEXAI
 * MUST NOT be set — gemini-cli would silently switch to pay-per-token
 * API billing. GeminiClient.start() refuses to spawn if any is present.
 */

import { GeminiClient, assertSubscriptionBilling } from './gemini-client.ts'
import { TelegramClient, type InboundMessage } from './telegram-client.ts'
import { SessionMap } from './session-map.ts'
import { TurnStreamConsumer } from './turn-stream-consumer.ts'
import { formatAcpUpdate } from './acp-item-formatter.ts'
import { attachmentsToAcpContent } from './attachment-to-input.ts'
import { config as loadDotenv } from 'dotenv'
import { existsSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

function loadStateDirEnv(stateDir: string): void {
  const envFile = `${stateDir}/.env`
  if (existsSync(envFile)) loadDotenv({ path: envFile, override: false })
}

const STATE_DIR =
  process.env.BRIDGE_STATE_DIR ?? `${process.env.HOME}/.codex-tg-bridge/state/gemini-default`

loadStateDirEnv(STATE_DIR)

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const DEFAULT_CWD = process.env.BRIDGE_DEFAULT_CWD ?? undefined
const GEMINI_BINARY = process.env.GEMINI_BINARY ?? '/opt/homebrew/bin/gemini'

if (!TG_TOKEN) {
  console.error('[gemini-bridge] missing TELEGRAM_BOT_TOKEN')
  process.exit(1)
}

// Fail-fast on subscription-safety check before we spawn gemini.
try {
  assertSubscriptionBilling()
} catch (err) {
  console.error('[gemini-bridge]', (err as Error).message)
  process.exit(1)
}

function log(level: 'info' | 'warn' | 'error', msg: string): void {
  process.stdout.write(`${new Date().toISOString()} [${level}] pid=${process.pid} ${msg}\n`)
}

async function main(): Promise<void> {
  log('info', `boot: STATE_DIR=${STATE_DIR} GEMINI=${GEMINI_BINARY} DEFAULT_CWD=${DEFAULT_CWD ?? '(client.process.cwd)'}`)

  const sessionMap = new SessionMap(`${STATE_DIR}/session-map.json`)
  await sessionMap.load()

  const gemini = new GeminiClient(GEMINI_BINARY)
  gemini.on('error', err => log('error', `gemini: ${(err as Error).message}`))
  gemini.on('stderr', line => {
    // Single-line summary to avoid log spam.
    if (line && !line.startsWith('Keychain initialization')) {
      log('info', `[gemini stderr] ${line.slice(0, 200)}`)
    }
  })
  gemini.on('exit', (code, signal) =>
    log('warn', `gemini --acp exited code=${code} signal=${signal}; bridge will exit`),
  )

  await gemini.start()
  const init = await gemini.initialize({ name: 'gemini-tg-bridge', version: '0.1.0' })
  log('info', `gemini ready: ${init.agentInfo.name} v${init.agentInfo.version}, capabilities=${JSON.stringify(init.agentCapabilities)}`)

  const tg = new TelegramClient(TG_TOKEN as string, STATE_DIR)
  tg.on('error', err => log('error', `telegram: ${(err as Error)?.message ?? err}`))

  // chat_id → sessionId (resume on restart). Note: gemini ACP sessions
  // live with the gemini subprocess; restart spawns a fresh gemini and
  // these stored sessionIds become invalid. We try session/load first,
  // fall back to session/new if it errors.
  const sessionToChat = new Map<string, string>()

  // Per-session text-streaming consumer for agent_message_chunk.
  // ACP doesn't have an explicit item/started for agentMessage — chunks
  // can start as soon as session/prompt is in flight. We create the
  // consumer lazily on first chunk per turn.
  const turnConsumers = new Map<string, TurnStreamConsumer>() // sessionId → consumer
  const activeTurnPromises = new Map<string, Promise<unknown>>()

  // --- ACP approvals: server-provided options ---------------------------
  // ApprovalTracker's "decision" string fits ACP optionId fine; we just
  // pass through whatever the agent offered. No enum validation —
  // optionIds come from the agent itself.
  const approvals = new Map<
    string,
    {
      reply: (result: unknown) => void
      options: Array<{ optionId: string; name: string; kind?: string }>
      sessionId: string
    }
  >()

  gemini.on('serverRequest', async (method: string, params: any, reply: (result: unknown) => void) => {
    if (method !== 'session/request_permission') {
      log('warn', `unhandled server request ${method}; cancelling`)
      reply({ outcome: { outcome: 'cancelled' } })
      return
    }
    const sessionId: string | undefined = params?.sessionId
    const toolCall = params?.toolCall ?? {}
    const options: Array<{ optionId: string; name: string; kind?: string }> = params?.options ?? []
    const chatId = sessionId ? sessionToChat.get(sessionId) : undefined

    if (!sessionId || !chatId || options.length === 0) {
      log('warn', `cannot route permission request: session=${sessionId} chat=${chatId} options=${options.length}`)
      reply({ outcome: { outcome: 'cancelled' } })
      return
    }

    const cbId = randomBytes(4).toString('hex')
    approvals.set(cbId, { reply, options, sessionId })

    const title = toolCall.title ?? 'tool call'
    const kind = toolCall.kind ?? 'tool'
    const rawInput = toolCall.rawInput ? `\n\`\`\`\n${JSON.stringify(toolCall.rawInput).slice(0, 600)}\n\`\`\`` : ''
    const text = `🛂 gemini wants permission for ${kind}: **${title}**${rawInput}`
    const buttonRows = options.map(opt => [
      { text: opt.name, data: `appr:${cbId}:${opt.optionId}` },
    ])
    try {
      await tg.sendWithButtons(chatId, text, buttonRows)
      log('info', `← gemini permission: ${title} (${options.length} options) → awaiting TG (cbId=${cbId})`)
    } catch (err) {
      log('warn', `permission TG send failed: ${(err as Error).message}; cancelling`)
      approvals.delete(cbId)
      reply({ outcome: { outcome: 'cancelled' } })
    }
  })

  tg.on('approval', (ev: { cbId: string; decision: string; chatId: string; messageId?: number }) => {
    const entry = approvals.get(ev.cbId)
    if (!entry) {
      log('warn', `approval cbId=${ev.cbId} not found (already resolved?)`)
      return
    }
    // decision is the optionId we asked the user to pick. ACP wants
    // { outcome: { outcome: "selected", optionId: "..." } }
    entry.reply({ outcome: { outcome: 'selected', optionId: ev.decision } })
    approvals.delete(ev.cbId)
    const opt = entry.options.find(o => o.optionId === ev.decision)
    log('info', `approval cbId=${ev.cbId} → ${opt?.name ?? ev.decision}`)
    if (ev.messageId) {
      void tg
        .editMessage(ev.chatId, ev.messageId, `🛂 ${opt?.name ?? ev.decision} — sent to gemini.`)
        .catch(() => {})
    }
  })

  // --- session/update notifications -------------------------------------
  gemini.on('notification', (method: string, params: any) => {
    log('info', `← gemini: ${method} ${params?.sessionId ? `session=${params.sessionId.slice(0, 8)}` : ''}${params?.update?.sessionUpdate ? ` kind=${params.update.sessionUpdate}` : ''}`)
  })

  gemini.on('method:session/update', async (p: any) => {
    const sessionId: string | undefined = p?.sessionId
    const update = p?.update
    if (!sessionId || !update) return
    const chatId = sessionToChat.get(sessionId)
    if (!chatId) return

    const kind = update.sessionUpdate

    if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') {
      // Streaming text. agent_thought_chunk is reasoning we hide;
      // agent_message_chunk is the user-facing reply.
      if (kind !== 'agent_message_chunk') return
      const text: string =
        (typeof update.content?.text === 'string' && update.content.text) ||
        (typeof update.content === 'string' && update.content) ||
        ''
      if (!text) return
      let consumer = turnConsumers.get(sessionId)
      if (!consumer) {
        consumer = new TurnStreamConsumer(tg, chatId, log)
        turnConsumers.set(sessionId, consumer)
        void consumer.run().catch(err => log('warn', `consumer.run: ${err.message}`))
      }
      consumer.enqueueDelta(text)
      return
    }

    // Tool calls / plan / etc. — render via formatter, send as separate
    // TG messages.
    const rendered = formatAcpUpdate(update)
    if (rendered) {
      try {
        await tg.reply(chatId, rendered)
      } catch (err) {
        log('warn', `acp update reply failed: ${(err as Error).message}`)
      }
    }
  })

  // --- inbound TG → gemini -----------------------------------------------
  tg.on('message', async (m: InboundMessage) => {
    log('info', `→ TG msg from chat=${m.chatId} user=${m.username}: ${m.text.slice(0, 80)}`)

    let sessionId = sessionMap.get(m.chatId)

    if (!sessionId) {
      // Fresh session for this chat.
      try {
        const r = await gemini.sessionNew(DEFAULT_CWD)
        sessionId = r.sessionId
        await sessionMap.set(m.chatId, sessionId)
        sessionToChat.set(sessionId, m.chatId)
        log('info', `session/new chat=${m.chatId} sessionId=${sessionId.slice(0, 8)}`)
      } catch (err) {
        log('error', `session/new failed: ${(err as Error).message}`)
        await tg.reply(m.chatId, `❌ gemini session/new failed: ${(err as Error).message}`)
        return
      }
    } else {
      sessionToChat.set(sessionId, m.chatId)
    }

    // Audit rule #3: raw text + raw ACP content blocks for any attached
    // images / audio / documents. attachmentsToAcpContent does no
    // wrapping — it maps the Attachment[] one-to-one to ContentBlock[]
    // (base64-encoding images / audio for the wire).
    try {
      const prompt = await attachmentsToAcpContent(m.text, m.attachments)
      const promise = gemini.sessionPrompt(sessionId, prompt)
      activeTurnPromises.set(sessionId, promise)
      const att = m.attachments.length
        ? ` attachments=[${m.attachments.map(a => a.kind).join(',')}]`
        : ''
      log('info', `session/prompt chat=${m.chatId} session=${sessionId.slice(0, 8)} prompt.blocks=${prompt.length}${att}`)
      const response = (await promise) as { stopReason?: string }
      activeTurnPromises.delete(sessionId)
      log('info', `session/prompt complete chat=${m.chatId} stopReason=${response?.stopReason ?? '?'}`)
      // Finalize streaming consumer for this turn.
      const consumer = turnConsumers.get(sessionId)
      if (consumer) {
        consumer.finish()
        turnConsumers.delete(sessionId)
      }
    } catch (err) {
      log('error', `session/prompt failed: ${(err as Error).message}`)
      activeTurnPromises.delete(sessionId)
      const consumer = turnConsumers.get(sessionId)
      if (consumer) {
        consumer.finish()
        turnConsumers.delete(sessionId)
      }
      await tg.reply(m.chatId, `❌ gemini session/prompt failed: ${(err as Error).message}`)
    }
  })

  tg.on('ready', () => log('info', 'telegram polling ready'))
  const { username } = await tg.start()
  log('info', `telegram bot connected as @${username}`)

  const shutdown = async (sig: string) => {
    log('warn', `shutting down (signal=${sig})`)
    try {
      await tg.stop()
    } catch {}
    gemini.stop()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch(err => {
  console.error('[gemini-bridge] fatal:', err)
  process.exit(1)
})
