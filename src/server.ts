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

import { CodexClient, assertSubscriptionAuth } from './codex-client.ts'
import { TelegramClient, type InboundMessage } from './telegram-client.ts'
import { SessionMap } from './session-map.ts'
import { formatItem } from './item-formatter.ts'
import { TurnStreamConsumer } from './turn-stream-consumer.ts'
import { ApprovalTracker, type ApprovalType } from './approval-tracker.ts'
import { attachmentsToCodexInput } from './attachment-to-input.ts'
import { SlashCommandRouter } from './slash-commands.ts'
import { config as loadDotenv } from 'dotenv'
import { existsSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

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

// Fail-fast on subscription-safety check. We exist to use the existing
// ChatGPT subscription quota — running on API tokens would silently
// burn pay-per-token billing every turn.
try {
  assertSubscriptionAuth()
} catch (err) {
  console.error('[bridge]', (err as Error).message)
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

  // 2026-05-23 — Tool-loop alert. Mirror of gemini-server.ts logic.
  // Counts non-agentMessage items per turn; resets on agentMessage; warns
  // once per turn at threshold suggesting /cancel. Most "tool-like" item
  // types we care about: localShellCall / functionCall / fileChange /
  // reasoning. We count everything that isn't agentMessage as a "tool
  // event" — simpler and tracks model decision count.
  const turnToolCallCount = new Map<string, number>() // turnId → count
  const turnAlertSent = new Set<string>()             // turnId already warned this turn
  const TOOL_CALL_ALERT_THRESHOLD = 10

  codex.on('notification', (method: string, params: any) => {
    log('info', `← codex: ${method} ${params?.threadId ? `thread=${params.threadId.slice(0, 8)}` : ''}${params?.turnId ? ` turn=${params.turnId.slice(0, 8)}` : ''}${params?.item?.type ? ` item.type=${params.item.type}` : ''}`)
  })

  // Server-to-client approval requests. Codex sends these when its
  // approvalPolicy is `on-request` (default) and it wants to run a
  // shell command / apply a file change / amend permissions. We MUST
  // respond by `id` or codex blocks indefinitely.
  //
  // Policy: forward each approval to Telegram as an inline-keyboard
  // prompt so the user can decide (Accept / Accept for session /
  // Decline). The bridge is for trusted personal use over a long arm —
  // auto-approving would defeat the safety net users get from codex's
  // approval policy.
  const approvals = new ApprovalTracker()

  function approvalTypeFromMethod(method: string): ApprovalType | null {
    switch (method) {
      case 'item/commandExecution/requestApproval':
        return 'commandExecution'
      case 'item/fileChange/requestApproval':
        return 'fileChange'
      case 'permissions/requestApproval':
        return 'permissions'
      default:
        return null
    }
  }

  function approvalButtons(type: ApprovalType): Array<Array<{ text: string; data: string }>> {
    // callback_data: appr:<cbId>:<decision> (placeholder; real cbId
    // substituted by caller per registered ApprovalTracker entry).
    if (type === 'commandExecution') {
      return [
        [
          { text: '✅ Accept', data: 'appr:CBID:accept' },
          { text: '🔁 Accept for session', data: 'appr:CBID:acceptForSession' },
        ],
        [{ text: '❌ Decline', data: 'appr:CBID:decline' }],
      ]
    }
    return [
      [
        { text: '✅ Accept', data: 'appr:CBID:accept' },
        { text: '❌ Decline', data: 'appr:CBID:decline' },
      ],
    ]
  }

  function describeApproval(method: string, params: any): string {
    const reason = params?.reason ? `\nreason: ${params.reason}` : ''
    if (method === 'item/commandExecution/requestApproval') {
      const cwd = params?.cwd ? `\ncwd: \`${params.cwd}\`` : ''
      const cmd = params?.command ? `\n\`\`\`\n${String(params.command).slice(0, 800)}\n\`\`\`` : ''
      return `🛂 codex wants to run a shell command${cwd}${cmd}${reason}`
    }
    if (method === 'item/fileChange/requestApproval') {
      const changes = params?.changes ?? params?.fileChange ?? []
      const summary = Array.isArray(changes)
        ? changes
            .map((c: any) => `  ${c.type ?? 'change'}: ${c.path ?? '?'}`)
            .slice(0, 6)
            .join('\n')
        : JSON.stringify(params ?? {}).slice(0, 600)
      return `🛂 codex wants to apply a file change\n${summary}${reason}`
    }
    if (method === 'permissions/requestApproval') {
      return `🛂 codex wants to amend permissions\n${JSON.stringify(params ?? {}, null, 2).slice(0, 1500)}${reason}`
    }
    return `🛂 codex requests approval (${method})\n${JSON.stringify(params ?? {}, null, 2).slice(0, 1500)}`
  }

  codex.on('serverRequest', async (method: string, params: any, reply: (result: unknown) => void) => {
    const type = approvalTypeFromMethod(method)
    const threadId: string | undefined = params?.threadId
    const itemId: string | undefined = params?.itemId
    const chatId = threadId ? threadToChat.get(threadId) : undefined

    if (!type || !threadId || !itemId || !chatId) {
      log('warn', `cannot route approval ${method}: type=${type} thread=${threadId} item=${itemId} chat=${chatId}; auto-declining`)
      reply({ decision: 'decline' })
      return
    }

    const cbId = approvals.register(type, { threadId, itemId }, reply)
    const text = describeApproval(method, params)
    const buttons = approvalButtons(type).map(row =>
      row.map(b => ({ text: b.text, data: b.data.replace('CBID', cbId) })),
    )
    try {
      await tg.sendWithButtons(chatId, text, buttons)
      log('info', `← codex REQUEST: ${method} item=${itemId.slice(0, 12)} → waiting for TG approval (cbId=${cbId})`)
    } catch (err) {
      log('warn', `failed to send approval prompt for ${method}: ${(err as Error).message}; auto-declining`)
      // Resolve the tracker to release the entry then signal decline.
      approvals.resolve(cbId, 'decline')
    }
  })

  // User clicked an approval button in Telegram.
  tg.on('approval', (ev: { cbId: string; decision: string; chatId: string; messageId?: number }) => {
    const res = approvals.resolve(ev.cbId, ev.decision)
    if (!res.ok) {
      log('warn', `approval click ignored: ${res.reason}`)
      return
    }
    log('info', `approval cbId=${ev.cbId} type=${res.type} → ${ev.decision} (user decision sent to codex)`)
    // Edit the prompt message to remove buttons + show the outcome.
    if (ev.messageId) {
      void tg
        .editMessage(ev.chatId, ev.messageId, `🛂 ${ev.decision} — sent to codex.`)
        .catch(() => {})
    }
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
      // Text appeared — reset tool-loop alert state for this turn.
      if (p.turnId) {
        turnToolCallCount.set(p.turnId, 0)
        turnAlertSent.delete(p.turnId)
      }
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

    // Tool-loop alert: count non-agentMessage items per turn. At
    // threshold, fire one TG warning suggesting /cancel.
    if (p.turnId) {
      const n = (turnToolCallCount.get(p.turnId) ?? 0) + 1
      turnToolCallCount.set(p.turnId, n)
      if (n === TOOL_CALL_ALERT_THRESHOLD && !turnAlertSent.has(p.turnId)) {
        turnAlertSent.add(p.turnId)
        log('warn', `tool-loop alert: turn=${p.turnId.slice(0, 8)} hit ${n} non-text items with no agentMessage`)
        try {
          await tg.reply(
            chatId,
            `⚠️ codex has produced ${n} items (tools / reasoning / etc.) without emitting a text reply — may be stuck in a tool loop.\nTap ⛔ Stop above or send /cancel to interrupt.`,
          )
        } catch (err) {
          log('warn', `tool-loop alert TG reply failed: ${(err as Error).message}`)
        }
      }
    }

    // Tool-call / reasoning / plan / file-change items: render via
    // formatter and send as a separate fresh TG message. These are
    // discrete events without streaming deltas.
    const text = formatItem(item)
    if (text) {
      try {
        await tg.reply(chatId, text)
      } catch (err) {
        log('warn', `reply failed for item ${item.type}: ${(err as Error).message}`)
      }
    }

    // Outbound media: when codex generates an image or writes an
    // image / PDF / archive on disk, surface the actual file so the user
    // sees it in Telegram instead of just a path string.
    void sendOutboundMedia(item, chatId).catch(err =>
      log('warn', `outbound media send failed for ${item.type}: ${err.message}`),
    )
  })

  /**
   * Detect agent-generated files worth sending as TG media.
   *
   * Codex item types we know how to surface:
   *   imageGeneration — has `savedPath` (absolute) when persisted
   *   fileChange      — `changes[].path`; image MIME → photo, else doc
   */
  async function sendOutboundMedia(item: any, chatId: string): Promise<void> {
    if (item.type === 'imageGeneration' && typeof item.savedPath === 'string') {
      try {
        await tg.sendPhoto(chatId, item.savedPath, item.revisedPrompt ?? undefined)
      } catch (err) {
        log('warn', `sendPhoto failed: ${(err as Error).message}`)
      }
      return
    }
    if (item.type === 'fileChange' && Array.isArray(item.changes)) {
      for (const c of item.changes) {
        const p: string | undefined = c?.path
        if (!p) continue
        const ext = p.toLowerCase().split('.').pop() ?? ''
        if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic'].includes(ext)) {
          try {
            await tg.sendPhoto(chatId, p, `📸 ${p}`)
          } catch (err) {
            log('warn', `sendPhoto(${p}) failed: ${(err as Error).message}`)
          }
        } else if (['pdf', 'zip', 'tar', 'gz', 'mp4', 'mov', 'wav', 'mp3'].includes(ext)) {
          try {
            await tg.sendDocument(chatId, p, `📎 ${p}`)
          } catch (err) {
            log('warn', `sendDocument(${p}) failed: ${(err as Error).message}`)
          }
        }
      }
    }
  }

  // We don't surface item/started events to TG (would be noisy — most show
  // up as item/completed later anyway). Logged via the generic listener
  // above for debugging.

  /**
   * Ask codex to rehydrate a thread by id (loads its rollout file). On
   * success returns the thread id; on failure clears the session-map
   * entry, opens a fresh thread, updates the map, and returns null so
   * the caller knows to re-read sessionMap.
   */
  async function tryResumeThread(threadId: string, chatId: string): Promise<string | null> {
    try {
      await codex.threadResume(threadId)
      log('info', `thread/resume chat=${chatId} threadId=${threadId.slice(0, 8)} (loaded from disk)`)
      return threadId
    } catch (err) {
      const msg = (err as Error).message
      log('warn', `thread/resume failed for ${threadId.slice(0, 8)} (${msg}); falling back to thread/start`)
      await sessionMap.clear(chatId)
      try {
        const resp = await codex.threadStart(DEFAULT_CWD)
        const fresh = resp.thread.id
        await sessionMap.set(chatId, fresh)
        threadToChat.delete(threadId)
        threadToChat.set(fresh, chatId)
        log('info', `thread/start (auto-recovery) chat=${chatId} threadId=${fresh.slice(0, 8)}`)
      } catch (err2) {
        log('error', `auto-recovery thread/start failed: ${(err2 as Error).message}`)
      }
      return null
    }
  }

  // Map turnId → TG message id of the "⛔ Stop" prompt so we can
  // remove the button when the turn completes (and ID the active turn
  // when the user clicks Stop).
  const stopMessageByTurn = new Map<string, { chatId: string; messageId: number; threadId: string }>()
  const turnIdByCancelRef = new Map<string, { threadId: string; turnId: string }>()

  codex.on('method:turn/started', async (p: any) => {
    const { threadId, turn } = p as { threadId: string; turn: { turnId: string } }
    const chatId = threadToChat.get(threadId)
    if (!chatId) return
    turnToChat.set(turn.turnId, chatId)

    // Post a "⛔ Stop" inline button anchored to this turn. Click →
    // codex.turnInterrupt(threadId, turnId).
    const ref = randomBytes(3).toString('hex')
    turnIdByCancelRef.set(ref, { threadId, turnId: turn.turnId })
    try {
      const msgId = await tg.sendWithButtons(chatId, '⏳ codex is working…', [
        [{ text: '⛔ Stop', data: `cancel:${ref}` }],
      ])
      stopMessageByTurn.set(turn.turnId, { chatId, messageId: msgId, threadId })
    } catch (err) {
      log('warn', `failed to post stop button: ${(err as Error).message}`)
    }
  })

  codex.on('method:turn/completed', async (p: any) => {
    const { turn } = p as { threadId: string; turn: { turnId: string } }
    turnToChat.delete(turn.turnId)
    // Reset tool-loop alert state for this turn.
    turnToolCallCount.delete(turn.turnId)
    turnAlertSent.delete(turn.turnId)
    // Remove stop button (edit message in place).
    const stop = stopMessageByTurn.get(turn.turnId)
    if (stop) {
      stopMessageByTurn.delete(turn.turnId)
      void tg.editMessage(stop.chatId, stop.messageId, '✓ codex turn complete').catch(() => {})
      void tg.clearButtons(stop.chatId, stop.messageId).catch(() => {})
    }
    for (const [ref, info] of turnIdByCancelRef.entries()) {
      if (info.turnId === turn.turnId) turnIdByCancelRef.delete(ref)
    }
  })

  // User clicked ⛔ Stop button.
  tg.on('cancel', async (ev: { ref: string; chatId: string; messageId?: number }) => {
    const info = turnIdByCancelRef.get(ev.ref)
    if (!info) {
      log('warn', `cancel ref=${ev.ref} not found (turn already complete?)`)
      return
    }
    turnIdByCancelRef.delete(ev.ref)
    log('info', `cancel ref=${ev.ref} → turn/interrupt thread=${info.threadId.slice(0,8)} turn=${info.turnId.slice(0,8)}`)
    try {
      await codex.turnInterrupt(info.threadId, info.turnId)
    } catch (err) {
      log('warn', `turn/interrupt failed: ${(err as Error).message}`)
    }
    if (ev.messageId) {
      void tg.editMessage(ev.chatId, ev.messageId, '⛔ cancel requested — codex stopping.').catch(() => {})
      void tg.clearButtons(ev.chatId, ev.messageId).catch(() => {})
    }
  })

  // --- slash command router ----------------------------------------------
  // Bridge-managed commands run before the message is forwarded to codex
  // as a prompt. Codex doesn't expose set_mode / set_model RPCs the way
  // gemini does — those settings live in ~/.codex/config.toml — so the
  // codex side only carries the universal bridge commands.
  const slash = new SlashCommandRouter()

  slash.register('new', '', 'drop the saved thread and start fresh on the next message', async (_args, ctx) => {
    await sessionMap.clear(ctx.chatId)
    await ctx.reply('🆕 next message will start a fresh thread.')
  })

  // Remember the most recent /list ordering per chat so /resume <number>
  // can resolve a numeric index back to the full thread id without the
  // user copy-pasting a UUID.
  const lastListByChat = new Map<string, string[]>()

  async function listThreadsHandler(_args: string, ctx: any): Promise<void> {
    const cur = sessionMap.get(ctx.chatId)
    const lines = [`current thread: \`${cur ?? '(none)'}\``, '']
    try {
      const result = (await codex.threadList({ limit: 15 })) as any
      const threads: any[] = result?.threads ?? result?.items ?? result?.data ?? []
      if (!Array.isArray(threads) || threads.length === 0) {
        lines.push('(codex returned no threads)')
      } else {
        lines.push(`codex threads (${threads.length}):`)
        const ids: string[] = []
        threads.slice(0, 15).forEach((t, i) => {
          const id = String(t.id ?? t.threadId ?? '?')
          ids.push(id)
          const tag = id === cur ? ' ← current' : ''
          const updated =
            t.updatedAt ?? t.updated_at ?? t.lastActivityAt ?? t.last_activity_at ?? '?'
          const title = t.title ?? t.name ?? t.preview ?? '(untitled)'
          lines.push(`${i + 1}. \`${id.slice(0, 8)}…\` ${String(updated).slice(0, 16)}  ${title}${tag}`)
        })
        lastListByChat.set(ctx.chatId, ids)
        lines.push('', 'use `/resume <number>` (e.g. `/resume 2`), `/resume <full-id>`, or `/resume_last`.')
      }
    } catch (err) {
      lines.push(`(thread/list failed: ${(err as Error).message})`)
    }
    await ctx.reply(lines.join('\n'))
  }

  slash.register('list', '', 'list recent codex threads (numbered; use /resume <number> to switch)', listThreadsHandler)
  // /sessions is a more-explicit alias people reach for ("show my sessions")
  // and avoids confusion with generic "list" if other bridges are added.
  slash.register('sessions', '', 'alias of /list — show recent codex threads', listThreadsHandler)

  async function resumeByRef(ref: string, ctx: any): Promise<void> {
    let targetId = ref
    // Resolve numeric short-cut against last /list ordering.
    if (/^\d+$/.test(ref)) {
      const ids = lastListByChat.get(ctx.chatId)
      if (!ids || ids.length === 0) {
        await ctx.reply('no numbered list available yet — run `/list` first, then `/resume <number>`.')
        return
      }
      const idx = parseInt(ref, 10) - 1
      if (idx < 0 || idx >= ids.length) {
        await ctx.reply(`number out of range — last /list had ${ids.length} entries.`)
        return
      }
      targetId = ids[idx]
    }
    await sessionMap.set(ctx.chatId, targetId)
    await ctx.reply(`✅ resumed thread \`${targetId}\` — next message attempts thread/resume.`)
  }

  slash.register('resume', '<number|threadId>', 'switch this chat to a stored thread (number from /list or full id)', async (args, ctx) => {
    const a = args.trim()
    if (!a) {
      await ctx.reply('usage: `/resume <number>` (e.g. `/resume 2`), `/resume <threadId>`, or `/resume_last`. Run `/list` first for the numbered list.')
      return
    }
    await resumeByRef(a, ctx)
  })

  slash.register('resume_last', '', 'switch to the most recent codex thread that you are NOT currently in', async (_args, ctx) => {
    // Auto-populate the list cache if it's not there.
    if (!lastListByChat.has(ctx.chatId) || (lastListByChat.get(ctx.chatId)?.length ?? 0) === 0) {
      await listThreadsHandler('', { ...ctx, reply: async () => {} })
    }
    const ids = lastListByChat.get(ctx.chatId)
    if (!ids || ids.length === 0) {
      await ctx.reply('no recent thread found.')
      return
    }
    // Skip the thread we're already in — common case is user opened
    // /new, exchanged nothing, and wants to go BACK to their previous
    // conversation. The fresh empty thread is now sorted as the most
    // recent, but resuming TO it from itself is a no-op the user didn't
    // want.
    const cur = sessionMap.get(ctx.chatId)
    const target = ids.find(id => id !== cur)
    if (!target) {
      await ctx.reply('only one thread exists (or you are already in the most recent one). nothing to switch to — try `/list` to pick a specific one or `/new` to start fresh.')
      return
    }
    await resumeByRef(target, ctx)
  })

  slash.register('cancel', '', 'interrupt the currently running turn', async (_args, ctx) => {
    // Find any active turn for this chat in turnIdByCancelRef.
    for (const [ref, info] of turnIdByCancelRef.entries()) {
      const cId = threadToChat.get(info.threadId)
      if (cId === ctx.chatId) {
        turnIdByCancelRef.delete(ref)
        try {
          await codex.turnInterrupt(info.threadId, info.turnId)
          await ctx.reply('⛔ cancel requested.')
        } catch (err) {
          await ctx.reply(`cancel failed: ${(err as Error).message}`)
        }
        return
      }
    }
    await ctx.reply('no active turn for this chat.')
  })

  // --- inbound TG → codex ------------------------------------------------
  tg.on('message', async (m: InboundMessage) => {
    log('info', `→ TG msg from chat=${m.chatId} user=${m.username}: ${m.text.slice(0, 80)}`)

    // Bridge-managed slash commands — dispatched before any codex prompt.
    if (m.text && m.text.trim().startsWith('/') && m.attachments.length === 0) {
      const handled = await slash.dispatch(m.text, {
        chatId: m.chatId,
        reply: (t: string) => tg.reply(m.chatId, t, m.messageId),
        log,
      })
      if (handled) return
    }

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
      // We have a stored thread id — ensure the app-server has it
      // loaded into memory. Codex persists threads on disk
      // (~/.codex/sessions/*.jsonl), so the server can rehydrate a
      // session that wasn't created in this app-server lifetime.
      // If thread/resume fails (e.g. the rollout file is gone) fall
      // back to thread/start so the user always gets a working session.
      threadToChat.set(threadId, m.chatId)
      const resumed = await tryResumeThread(threadId, m.chatId)
      if (resumed === null) {
        // Original threadId is unrecoverable; threadId variable was
        // already replaced inside tryResumeThread via callback below.
        threadId = sessionMap.get(m.chatId)!
      }
    }

    // Audit rule #3: raw text + raw localImage paths. attachmentsToCodexInput
    // does NOT add any wrapping / framing — it just maps Attachment[] to
    // codex's UserInput shape and concatenates mention lines for media
    // codex can't ingest natively (audio, video).
    try {
      const input = await attachmentsToCodexInput(m.text, m.attachments)
      await codex.turnStart(threadId, input)
      const att = m.attachments.length
        ? ` attachments=[${m.attachments.map(a => a.kind).join(',')}]`
        : ''
      log('info', `turn/start chat=${m.chatId} threadId=${threadId.slice(0, 8)} input.blocks=${input.length}${att}`)
    } catch (err) {
      log('error', `turn/start failed: ${(err as Error).message}`)
      await tg.reply(m.chatId, `❌ codex turn/start failed: ${(err as Error).message}`)
    }
  })

  tg.on('ready', () => log('info', 'telegram polling ready'))
  const { username } = await tg.start()
  log('info', `telegram bot connected as @${username}`)

  // Publish slash-command suggestions so Telegram's client shows a `/`
  // autocomplete popup. Without this, typing the full command still
  // works but the menu hint never appears.
  try {
    const cmds = slash.listForBotApi()
    await tg.setMyCommands(cmds)
    log('info', `setMyCommands published (${cmds.length}): ${cmds.map(c => c.command).join(', ')}`)
  } catch (err) {
    log('warn', `setMyCommands failed: ${(err as Error).message}`)
  }

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
