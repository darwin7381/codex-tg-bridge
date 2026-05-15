/**
 * codex-tg-bridge — zero-degradation Telegram ↔ Codex app-server bridge.
 *
 * The five audit invariants:
 *   #1 thread/start sends NO baseInstructions / developerInstructions /
 *      personality / model / approvalPolicy / sandbox overrides. (enforced
 *      in codex-client.ts:threadStart)
 *   #2 turn/start sends ONLY threadId + input. No model / personality /
 *      effort / cwd / sandbox overrides per turn. (enforced in
 *      codex-client.ts:turnStart)
 *   #3 user TG message → turn/start input text is byte-for-byte the raw
 *      text. No prefix / suffix / instruction wrapping. (enforced below)
 *   #4 every item/* notification from codex is forwarded to TG without
 *      filtering. Unknown item types render to a generic dump so nothing
 *      is silently dropped. (enforced in item-formatter.ts)
 *   #5 the bridge does not read codex config and does not pass any config
 *      overrides — codex reads ~/.codex/config.toml verbatim every time
 *      it spawns a thread / turn.
 *
 * Environment variables:
 *   TELEGRAM_BOT_TOKEN   bot token (also read from $STATE_DIR/.env)
 *   CODEX_APPSERVER_URL  ws://127.0.0.1:PORT for the codex daemon
 *   BRIDGE_STATE_DIR     where access.json + session-map.json live
 *   BRIDGE_DEFAULT_CWD   optional: cwd to pass to thread/start when starting
 *                         a fresh thread for a new TG chat. Codex defaults
 *                         to its own cwd if omitted.
 */

import { CodexClient } from './codex-client.ts'
import { TelegramClient, type InboundMessage } from './telegram-client.ts'
import { SessionMap } from './session-map.ts'
import { formatItem } from './item-formatter.ts'
import { TurnStreamConsumer } from './turn-stream-consumer.ts'
import { config as loadDotenv } from 'dotenv'
import { existsSync } from 'node:fs'

// --- env loading ----------------------------------------------------------

function loadStateDirEnv(stateDir: string): void {
  const envFile = `${stateDir}/.env`
  if (existsSync(envFile)) {
    loadDotenv({ path: envFile, override: false })
  }
}

const STATE_DIR =
  process.env.BRIDGE_STATE_DIR ?? `${process.env.HOME}/.codex-tg-bridge`

loadStateDirEnv(STATE_DIR)

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const CODEX_URL = process.env.CODEX_APPSERVER_URL ?? 'ws://127.0.0.1:17651'
const DEFAULT_CWD = process.env.BRIDGE_DEFAULT_CWD ?? undefined

if (!TG_TOKEN) {
  console.error('[bridge] missing TELEGRAM_BOT_TOKEN (set in env or $STATE_DIR/.env)')
  process.exit(1)
}

// --- logging --------------------------------------------------------------

function log(level: 'info' | 'warn' | 'error', msg: string): void {
  const ts = new Date().toISOString()
  process.stdout.write(`${ts} [${level}] pid=${process.pid} ${msg}\n`)
}

// --- main -----------------------------------------------------------------

async function main(): Promise<void> {
  log('info', `boot: STATE_DIR=${STATE_DIR} CODEX_URL=${CODEX_URL} DEFAULT_CWD=${DEFAULT_CWD ?? '(server default)'}`)

  const sessionMap = new SessionMap(`${STATE_DIR}/session-map.json`)
  await sessionMap.load()

  const codex = new CodexClient(CODEX_URL)
  codex.on('error', err => log('error', `codex client: ${(err as Error).message}`))
  codex.on('close', () => log('warn', 'codex websocket closed; bridge will exit'))

  await codex.connect()
  log('info', `connected to codex app-server at ${CODEX_URL}`)

  const init = await codex.initialize({ name: 'codex-tg-bridge', version: '0.1.0' })
  log('info', `codex says: userAgent="${init.userAgent}", codexHome=${init.codexHome}, platform=${init.platformOs}`)

  const tg = new TelegramClient(TG_TOKEN as string, STATE_DIR)
  tg.on('error', err => log('error', `telegram client: ${(err as Error)?.message ?? err}`))

  // Track which TG chat is associated with which codex turn, so streaming
  // notifications can be routed back to the right chat.
  const turnToChat = new Map<string, string>() // turnId → chatId
  const threadToChat = new Map<string, string>() // threadId → chatId

  // Per-agentMessage streaming. One TurnStreamConsumer owns one Telegram
  // message and edits it in place as deltas arrive. Time-throttled to
  // ~1 edit/sec with adaptive backoff to 10s on flood control. Ported
  // from Hermes' gateway/stream_consumer.py (production battle-tested).
  //
  // Keyed by codex itemId so multiple concurrent agentMessages within
  // one turn each get their own message (rare, but codex's protocol
  // allows it).
  const streamConsumers = new Map<string, TurnStreamConsumer>()

  codex.on('notification', (method: string, params: any) => {
    log('info', `← codex: ${method} ${params?.threadId ? `thread=${params.threadId.slice(0, 8)}` : ''}${params?.turnId ? ` turn=${params.turnId.slice(0, 8)}` : ''}${params?.item?.type ? ` item.type=${params.item.type}` : ''}`)
  })

  // --- streaming deltas: edit-in-place pattern ---------------------------
  // While codex streams agentMessage deltas, we edit a single Telegram
  // message rather than spamming new ones. New reply only fires on item
  // completion.
  // On item/started (type=agentMessage): spawn a stream consumer for
  // this item. From this point the consumer owns one TG message and
  // updates it in place via item/agentMessage/delta + item/completed.
  codex.on('method:item/started', (p: any) => {
    if (p?.item?.type !== 'agentMessage') return
    const chatId = turnToChat.get(p.turnId) ?? threadToChat.get(p.threadId)
    if (!chatId) return
    const consumer = new TurnStreamConsumer(tg, chatId, log)
    streamConsumers.set(p.item.id, consumer)
    void consumer.run().catch(err => log('warn', `consumer.run threw: ${err.message}`))
  })

  // Delta producer — non-blocking enqueue.
  codex.on('method:item/agentMessage/delta', (p: any) => {
    const consumer = streamConsumers.get(p.itemId)
    if (consumer) consumer.enqueueDelta(p.delta)
  })

  codex.on('method:item/completed', async (p: any) => {
    const item = p.item
    const chatId = turnToChat.get(p.turnId) ?? threadToChat.get(p.threadId)
    if (!chatId) return

    // agentMessage items are managed by their streaming consumer.
    // Hand the canonical final text to it so the stream replaces any
    // delta drift with the polished version, then let the consumer
    // close out its message.
    if (item.type === 'agentMessage') {
      const consumer = streamConsumers.get(item.id)
      if (consumer) {
        consumer.finish(typeof item.text === 'string' ? item.text : undefined)
        streamConsumers.delete(item.id)
      } else {
        // No consumer (e.g. delta was empty, item/started missed) — just
        // send the text as a fresh reply.
        const text = formatItem(item)
        if (text) {
          try {
            await tg.reply(chatId, text)
          } catch (err) {
            log('warn', `agentMessage fallback reply failed: ${(err as Error).message}`)
          }
        }
      }
      return
    }

    // Tool-call / reasoning / plan / file-change items: render via
    // formatter and send as a separate fresh TG message. These are
    // discrete events without streaming deltas.
    const text = formatItem(item)
    if (!text) return
    try {
      await tg.reply(chatId, text)
    } catch (err) {
      log('warn', `reply failed for item ${item.type}: ${(err as Error).message}`)
    }
  })

  // We don't surface item/started events to TG (would be noisy — most show
  // up as item/completed later anyway). Logged via the generic listener
  // above for debugging.

  codex.on('method:turn/started', (p: any) => {
    const { threadId, turn } = p as { threadId: string; turn: { turnId: string } }
    const chatId = threadToChat.get(threadId)
    if (chatId) turnToChat.set(turn.turnId, chatId)
  })

  codex.on('method:turn/completed', async (p: any) => {
    const { turn } = p as { threadId: string; turn: { turnId: string } }
    turnToChat.delete(turn.turnId)
  })

  // --- inbound TG → codex ------------------------------------------------
  tg.on('message', async (m: InboundMessage) => {
    log('info', `→ TG msg from chat=${m.chatId} user=${m.username}: ${m.text.slice(0, 80)}`)

    let threadId = sessionMap.get(m.chatId)

    if (!threadId) {
      // New chat (or post-restart with no persisted mapping). Start a
      // fresh thread. Audit rule #1: no overrides.
      try {
        const resp = await codex.threadStart(DEFAULT_CWD)
        threadId = resp.thread.id
        await sessionMap.set(m.chatId, threadId)
        threadToChat.set(threadId, m.chatId)
        log('info', `thread/start chat=${m.chatId} threadId=${threadId.slice(0, 8)}`)
      } catch (err) {
        log('error', `thread/start failed: ${(err as Error).message}`)
        await tg.reply(m.chatId, `❌ codex thread/start failed: ${(err as Error).message}`)
        return
      }
    } else {
      threadToChat.set(threadId, m.chatId)
    }

    // Audit rule #3: raw text, no prefix/suffix.
    try {
      await codex.turnStart(threadId, m.text)
      log('info', `turn/start chat=${m.chatId} threadId=${threadId.slice(0, 8)} input.len=${m.text.length}`)
    } catch (err) {
      log('error', `turn/start failed: ${(err as Error).message}`)
      await tg.reply(m.chatId, `❌ codex turn/start failed: ${(err as Error).message}`)
    }
  })

  tg.on('ready', () => log('info', 'telegram polling ready'))
  const { username } = await tg.start()
  log('info', `telegram bot connected as @${username}`)

  // --- shutdown ----------------------------------------------------------
  const shutdown = async (sig: string) => {
    log('warn', `shutting down (signal=${sig})`)
    try {
      await tg.stop()
    } catch {}
    codex.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch(err => {
  console.error('[bridge] fatal:', err)
  process.exit(1)
})
