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
import { formatAcpUpdate, sanitizeForTg, extractGeneratedPaths } from './acp-item-formatter.ts'
import { attachmentsToAcpContent } from './attachment-to-input.ts'
import { SlashCommandRouter } from './slash-commands.ts'
import { config as loadDotenv } from 'dotenv'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { randomBytes } from 'node:crypto'

function loadStateDirEnv(stateDir: string): void {
  const envFile = `${stateDir}/.env`
  if (existsSync(envFile)) loadDotenv({ path: envFile, override: false })
}

/**
 * Scan gemini-cli's persisted chats for the current project. ACP's
 * `session/list` does not exist on gemini's wire (confirmed
 * 2026-05-16 — returns -32601 Method not found). Sessions are
 * persisted on disk at `~/.gemini/tmp/<basename(cwd)>/chats/session-*`.
 *
 * Format note (2026-05-23): gemini ~v0.34 switched from `.json` (one
 * big JSON document with a `messages[]` field) to `.jsonl` (NDJSON —
 * one JSON line per event, first line is metadata, subsequent lines are
 * messages + `$set` mutation ops). We handle BOTH formats: filename
 * suffix decides the parser path. Sessions in `.jsonl` only were
 * silently invisible until this fix (Joey 2026-05-23).
 *
 * Each file's `sessionId` field is the canonical id that
 * `session/load` accepts to restore message history.
 */
type DiskSession = {
  sessionId: string
  file: string
  mtimeMs: number
  lastUpdated?: string
  title?: string
  msgCount?: number
}

function listGeminiSessionsFromDisk(cwd?: string, limit = 30): DiskSession[] {
  const projectDir = basename(cwd ?? process.cwd())
  const chatsDir = join(
    process.env.HOME ?? '',
    '.gemini',
    'tmp',
    projectDir,
    'chats',
  )
  if (!existsSync(chatsDir)) return []
  const entries: DiskSession[] = []
  for (const name of readdirSync(chatsDir)) {
    if (!name.startsWith('session-')) continue
    const isJsonl = name.endsWith('.jsonl')
    const isJson = name.endsWith('.json')
    if (!isJsonl && !isJson) continue
    const full = join(chatsDir, name)
    let mtimeMs = 0
    try {
      mtimeMs = statSync(full).mtimeMs
    } catch {
      continue
    }
    try {
      const raw = readFileSync(full, 'utf8')

      if (isJsonl) {
        // NDJSON: line 1 = session metadata; line 2+ = messages / $set ops.
        // Reading large transcripts (we've seen 80MB) is wasteful — cap.
        // The first ~32 KiB is plenty for metadata + first user message.
        const chunk = raw.slice(0, 32 * 1024)
        let sessionId: string | undefined
        let lastUpdated: string | undefined
        let title: string | undefined
        let msgCount = 0
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('{')) continue
          let j
          try { j = JSON.parse(line) } catch { continue }
          if (typeof j.sessionId === 'string' && !sessionId) sessionId = j.sessionId
          if (typeof j.lastUpdated === 'string') lastUpdated = j.lastUpdated
          if (j.$set?.lastUpdated && typeof j.$set.lastUpdated === 'string') {
            lastUpdated = j.$set.lastUpdated
          }
          // user / gemini messages have type='user'|'gemini' and content
          if (j.type === 'user' || j.type === 'gemini' || j.type === 'assistant') {
            msgCount++
            if (!title && j.type === 'user') {
              const c = j.content
              const text =
                Array.isArray(c) && c[0] && typeof (c[0] as any).text === 'string'
                  ? (c[0] as any).text
                  : typeof c === 'string'
                    ? c
                    : ''
              if (text) title = String(text).replace(/\s+/g, ' ').trim().slice(0, 100)
            }
          }
        }
        if (!sessionId) continue
        entries.push({ sessionId, file: name, mtimeMs, lastUpdated, title, msgCount })
        continue
      }

      // legacy .json — one JSON document with messages[]
      const j = JSON.parse(raw) as {
        sessionId?: string
        lastUpdated?: string
        messages?: Array<{ type?: string; content?: unknown }>
      }
      if (!j.sessionId) continue
      let title: string | undefined
      for (const m of j.messages ?? []) {
        if (m.type !== 'user') continue
        const c = m.content
        const text =
          Array.isArray(c) && c[0] && typeof (c[0] as any).text === 'string'
            ? (c[0] as any).text
            : typeof c === 'string'
              ? c
              : ''
        if (text) {
          title = String(text).replace(/\s+/g, ' ').trim().slice(0, 100)
          break
        }
      }
      entries.push({
        sessionId: j.sessionId,
        file: name,
        mtimeMs,
        lastUpdated: j.lastUpdated,
        title,
        msgCount: j.messages?.length ?? 0,
      })
    } catch {
      // Skip malformed files (e.g. dump.txt, extract.js scratch files
      // sitting in this dir from earlier debugging).
    }
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return entries.slice(0, limit)
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

  // 2026-05-23 — Tool-call loop alert (Joey 2026-05-22 observation).
  // Gemini occasionally enters "self-investigation" mode where it chains
  // many shell tool calls + thought chunks without ever emitting an
  // agent_message_chunk → user sees only "execute: ..." spam, no text
  // reply. Counter increments on tool_call during a live turn, resets on
  // agent_message_chunk or turn end. Hitting threshold fires a one-time
  // warning per turn suggesting /cancel.
  const turnToolCallCount = new Map<string, number>() // sessionId → count
  const turnAlertSent = new Set<string>()             // sessionId already warned this turn
  const TOOL_CALL_ALERT_THRESHOLD = 10

  // 2026-05-23 — Per-chat verbosity (Joey 2026-05-22):
  //   quiet   = hide thought_chunks (default; less noise)
  //             also suppress tool_call_update lines that carry no content
  //   normal  = same as quiet (kept as separate level for future)
  //   verbose = relay thought_chunks truncated (~100 chars dim) so user can
  //             see what gemini is reasoning about live
  // Toggle via /verbosity <quiet|normal|verbose>. In-memory only; resets
  // on bridge restart back to 'normal'.
  type Verbosity = 'quiet' | 'normal' | 'verbose'
  const chatVerbosity = new Map<string, Verbosity>() // chatId → level
  const getVerbosity = (cid: string): Verbosity => chatVerbosity.get(cid) ?? 'normal'

  // Throttle thought_chunk relays so a flood of small chunks doesn't
  // produce 50 TG messages per turn. We coalesce thoughts within a
  // 1500ms window per chat into one summary message.
  type ThoughtBuf = { text: string; timer: ReturnType<typeof setTimeout> | null }
  const thoughtBuffers = new Map<string, ThoughtBuf>() // chatId → buffered chunks

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
    let options: Array<{ optionId: string; name: string; kind?: string }> = params?.options ?? []
    const chatId = sessionId ? sessionToChat.get(sessionId) : undefined

    if (!sessionId || !chatId) {
      log('warn', `cannot route permission request: session=${sessionId} chat=${chatId}`)
      reply({ outcome: { outcome: 'cancelled' } })
      return
    }

    // Defensive: if the agent supplied no options (some custom tools
    // like ask_user / exit_plan_mode arrive without an explicit option
    // set), synthesize Approve/Decline so the user can still respond
    // rather than the bridge silently cancelling and deadlocking the
    // agent.
    if (options.length === 0) {
      log('warn', `permission request has 0 options; synthesizing approve/decline for ${toolCall.title ?? 'tool call'}`)
      options = [
        { optionId: 'approve', name: '✅ Approve' },
        { optionId: 'decline', name: '❌ Decline' },
      ]
    }

    // Auto-approve mode: user previously clicked "✋ Auto-approve all"
    // for this session. Bridge picks the most-permissive option and
    // resolves the prompt without bothering the user.
    if (autoApprove.has(sessionId)) {
      const picked = pickPermissiveOption(options)
      if (picked) {
        reply({ outcome: { outcome: 'selected', optionId: picked.optionId } })
        log('info', `← gemini permission AUTO: ${toolCall.title ?? 'tool call'} → "${picked.name}" (session in auto-approve mode)`)
        return
      }
      // Couldn't pick — fall through to normal prompt.
    }

    const cbId = randomBytes(4).toString('hex')
    approvals.set(cbId, { reply, options, sessionId })

    const title = toolCall.title ?? 'tool call'
    const kind = toolCall.kind ?? 'tool'
    // Surface the actual command / diff / args so the user can decide
    // informed instead of just guessing from a name (Joey HedgeDoc #3).
    const detailParts: string[] = []
    const rawInput = toolCall.rawInput ?? toolCall.input
    if (rawInput && typeof rawInput === 'object') {
      const cmd = (rawInput as any).command ?? (rawInput as any).cmd
      if (typeof cmd === 'string') detailParts.push(`\`\`\`\n${sanitizeForTg(cmd).slice(0, 800)}\n\`\`\``)
      else
        detailParts.push(`args:\n\`\`\`\n${sanitizeForTg(JSON.stringify(rawInput, null, 2)).slice(0, 800)}\n\`\`\``)
    }
    if (Array.isArray(toolCall.content)) {
      for (const c of toolCall.content.slice(0, 3)) {
        const t = c?.type
        if (t === 'diff') {
          const path = c.path ?? '?'
          const oldT = sanitizeForTg(String(c.oldText ?? '')).slice(0, 400)
          const newT = sanitizeForTg(String(c.newText ?? '')).slice(0, 400)
          detailParts.push(`diff: \`${path}\`\n--- old\n${oldT}\n+++ new\n${newT}`)
        } else if (t === 'text' && typeof c.text === 'string') {
          detailParts.push(sanitizeForTg(c.text).slice(0, 600))
        }
      }
    }
    const detail = detailParts.length > 0 ? '\n\n' + detailParts.join('\n') : ''
    const text = `🛂 gemini wants permission for ${kind}: **${title}**${detail}`
    // Render each agent-supplied option on its own row, then append a
    // single "auto-approve everything for this session" override row.
    const buttonRows: Array<Array<{ text: string; data: string }>> = options.map(opt => [
      { text: opt.name, data: `appr:${cbId}:${opt.optionId}` },
    ])
    buttonRows.push([
      { text: '✋ Auto-approve all (this session)', data: `appr:${cbId}:__BRIDGE_AUTO_ALL__` },
    ])
    try {
      await tg.sendWithButtons(chatId, text, buttonRows)
      log('info', `← gemini permission: ${title} (${options.length} options + auto-all) → awaiting TG (cbId=${cbId})`)
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

    // Special sentinel decision: enable bridge-level auto-approve for
    // the rest of this session, then resolve THIS prompt with the
    // agent's most-permissive option so the agent can proceed.
    if (ev.decision === '__BRIDGE_AUTO_ALL__') {
      autoApprove.add(entry.sessionId)
      const picked = pickPermissiveOption(entry.options)
      if (!picked) {
        // No safe pick — reject gracefully.
        entry.reply({ outcome: { outcome: 'cancelled' } })
      } else {
        entry.reply({ outcome: { outcome: 'selected', optionId: picked.optionId } })
      }
      approvals.delete(ev.cbId)
      log(
        'info',
        `approval cbId=${ev.cbId} → AUTO-APPROVE-ALL enabled for session=${entry.sessionId.slice(0, 8)} (this prompt resolved as "${picked?.name ?? 'cancel'}")`,
      )
      if (ev.messageId) {
        void tg
          .editMessage(ev.chatId, ev.messageId, `✋ auto-approve all enabled for this session — gemini won't ask again until the session ends`)
          .catch(() => {})
        void tg.clearButtons(ev.chatId, ev.messageId).catch(() => {})
      }
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
      void tg.clearButtons(ev.chatId, ev.messageId).catch(() => {})
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
      // Streaming text. agent_thought_chunk is reasoning;
      // agent_message_chunk is the user-facing reply.
      const raw: string =
        (typeof update.content?.text === 'string' && update.content.text) ||
        (typeof update.content === 'string' && update.content) ||
        ''
      const text = sanitizeForTg(raw)
      if (!text) return

      if (kind === 'agent_thought_chunk') {
        // Relay only in 'verbose' mode. Coalesce chunks within 1500ms so
        // we send ONE digest message per burst of thinking, not 30.
        if (getVerbosity(chatId) !== 'verbose') return
        const existing = thoughtBuffers.get(chatId)
        const combined = (existing?.text ?? '') + text
        if (existing?.timer) clearTimeout(existing.timer)
        const timer = setTimeout(() => {
          const buf = thoughtBuffers.get(chatId)
          if (!buf) return
          thoughtBuffers.delete(chatId)
          // Truncate to ~250 chars; collapse whitespace for dense display.
          const dense = buf.text.replace(/\s+/g, ' ').trim()
          const preview = dense.length > 250 ? dense.slice(0, 250) + '…' : dense
          if (!preview) return
          tg.reply(chatId, `🤔 _${preview}_`).catch(err =>
            log('warn', `thought relay failed: ${(err as Error).message}`),
          )
        }, 1500)
        thoughtBuffers.set(chatId, { text: combined, timer })
        return
      }

      // agent_message_chunk — text appeared, reset tool-loop alert + flush thoughts.
      turnToolCallCount.set(sessionId, 0)
      turnAlertSent.delete(sessionId)
      const tbuf = thoughtBuffers.get(chatId)
      if (tbuf?.timer) { clearTimeout(tbuf.timer); thoughtBuffers.delete(chatId) }
      let consumer = turnConsumers.get(sessionId)
      if (!consumer) {
        consumer = new TurnStreamConsumer(tg, chatId, log)
        turnConsumers.set(sessionId, consumer)
        void consumer.run().catch(err => log('warn', `consumer.run: ${err.message}`))
      }
      consumer.enqueueDelta(text)
      return
    }

    // 2026-05-22 — During sessionLoad replay (gemini re-emits historical
    // conversation events including every past tool_call), suppress
    // tool_call / tool_call_update because the user doesn't want to see
    // "👀 read: ReadFile / 🔍 search: SearchText" walls for past
    // internal warm-up. During a LIVE turn (we have an activeTurnPromise
    // for this session) we keep them — tool calls during normal
    // conversation ARE useful. write_todos and plan stay visible in
    // both modes because they're high-signal.
    const isReplay = !activeTurnPromises.has(sessionId)
    if (
      isReplay &&
      (kind === 'tool_call' || kind === 'tool_call_update')
    ) {
      const u = update as any
      const isWriteTodos =
        (u.title && /todo/i.test(u.title)) ||
        (u.rawInput && Array.isArray(u.rawInput.todos))
      if (!isWriteTodos) {
        log('info', `suppressing replay ${kind} title=${u.title ?? '?'}`)
        return
      }
    }

    // Tool-loop alert: count live tool_call (not tool_call_update — those
    // are status updates for an already-counted call). At threshold, fire
    // one TG warning suggesting /cancel. Reset is handled by
    // agent_message_chunk above and at turn end below.
    if (kind === 'tool_call' && !isReplay) {
      const n = (turnToolCallCount.get(sessionId) ?? 0) + 1
      turnToolCallCount.set(sessionId, n)
      if (n === TOOL_CALL_ALERT_THRESHOLD && !turnAlertSent.has(sessionId)) {
        turnAlertSent.add(sessionId)
        log('warn', `tool-loop alert: session=${sessionId.slice(0, 8)} hit ${n} tool calls with no agent_message_chunk`)
        try {
          await tg.reply(
            chatId,
            `⚠️ gemini has run ${n} tool calls without emitting a text reply — may be stuck in a self-investigation loop.\nTap ⛔ Stop above or send /cancel to interrupt.`,
          )
        } catch (err) {
          log('warn', `tool-loop alert TG reply failed: ${(err as Error).message}`)
        }
      }
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

    // Outbound media: if the agent just produced an image / PDF /
    // archive / video / audio file on disk, surface it to Telegram
    // as a photo or document instead of leaving the user with a
    // path-string mention.
    for (const p of extractGeneratedPaths(update)) {
      const ext = p.toLowerCase().split('.').pop() ?? ''
      try {
        if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic'].includes(ext)) {
          await tg.sendPhoto(chatId, p, `📸 ${p}`)
        } else if (['pdf', 'zip', 'tar', 'gz', 'mp4', 'mov', 'wav', 'mp3', 'm4a'].includes(ext)) {
          await tg.sendDocument(chatId, p, `📎 ${p}`)
        }
      } catch (err) {
        log('warn', `outbound media (${p}) failed: ${(err as Error).message}`)
      }
    }
  })

  // Map cancel-ref → sessionId for the ⛔ Stop button below.
  const cancelRefToSession = new Map<string, string>()
  const stopMessageBySession = new Map<string, { chatId: string; messageId: number }>()

  // Per-session "auto-approve all" toggle. When set, the bridge auto-
  // replies to every session/request_permission for that session with
  // the most-permissive option offered by the agent — no TG prompt
  // shown. Persists in-memory only; gone on bridge restart or session
  // change.
  const autoApprove = new Set<string>()

  // Tracks which sessionIds are known to be attached to the live
  // gemini-cli subprocess. session/prompt with an id gemini doesn't
  // know about throws "Session not found" → we have to call
  // session/load(id, cwd) first. session/new auto-attaches; for
  // restored ids from disk we need an explicit load.
  const loadedSessions = new Set<string>()

  /** Pick the option most likely to mean "always allow". Heuristic over
   *  agent-supplied option names; falls back to first option. */
  function pickPermissiveOption(
    options: ReadonlyArray<{ optionId: string; name: string; kind?: string }>,
  ): { optionId: string; name: string; kind?: string } | undefined {
    if (options.length === 0) return undefined
    const lc = (s: string): string => s.toLowerCase()
    // Priority: "always allow" > "allow always" > "allow" > anything with "yes"
    const byKeyword = (kw: string) => options.find(o => lc(o.name).includes(kw))
    return (
      byKeyword('always allow') ??
      byKeyword('allow always') ??
      byKeyword('always') ??
      byKeyword('allow') ??
      byKeyword('yes') ??
      options[0]
    )
  }

  // User clicked ⛔ Stop button.
  tg.on('cancel', async (ev: { ref: string; chatId: string; messageId?: number }) => {
    const sessionId = cancelRefToSession.get(ev.ref)
    if (!sessionId) {
      log('warn', `cancel ref=${ev.ref} not found (turn already complete?)`)
      return
    }
    cancelRefToSession.delete(ev.ref)
    log('info', `cancel ref=${ev.ref} → session/cancel session=${sessionId.slice(0, 8)}`)
    try {
      await gemini.sessionCancel(sessionId)
    } catch (err) {
      log('warn', `session/cancel failed: ${(err as Error).message}`)
    }
    if (ev.messageId) {
      void tg
        .editMessage(ev.chatId, ev.messageId, '⛔ cancel requested — gemini stopping.')
        .catch(() => {})
      void tg.clearButtons(ev.chatId, ev.messageId).catch(() => {})
    }
  })

  // User tapped a /list button → callback emits `resume:<session-id>`
  // forwarded by telegram-client.ts as the 'resume' event. We route into
  // resumeByRef() — same code path as the text command /resume <id>.
  tg.on('resume', async (ev: { targetId: string; chatId: string; messageId?: number }) => {
    log('info', `tg button → resume target=${ev.targetId.slice(0, 8)}… chat=${ev.chatId}`)
    const ctx = {
      chatId: ev.chatId,
      reply: async (text: string) => { await tg.reply(ev.chatId, text) },
      log,
    }
    try {
      await resumeByRef(ev.targetId, ctx)
    } catch (err) {
      log('warn', `button resume failed: ${(err as Error).message}`)
      await tg.reply(ev.chatId, `❌ resume failed: ${(err as Error).message}`).catch(() => {})
    }
  })

  // --- slash command router ----------------------------------------------
  // Bridge-managed commands run BEFORE the message is forwarded to gemini
  // as a prompt. Gemini's own `/memory`, `/extensions`, `/init`, `/restore`
  // commands are forwarded via `/cmd <rest>` so users can still invoke
  // them without needing the bridge to know every gemini command name.
  const slash = new SlashCommandRouter()

  slash.register('new', '', 'drop the saved session and start fresh on the next message', async (_args, ctx) => {
    await sessionMap.clear(ctx.chatId)
    await ctx.reply('🆕 next message will start a fresh session.')
  })

  // Remember the most recent /list ordering per chat so /resume <number>
  // can resolve a numeric index without copy-pasting a UUID.
  const lastListByChat = new Map<string, string[]>()

  async function listSessionsHandler(_args: string, ctx: any): Promise<void> {
    const cur = sessionMap.get(ctx.chatId)
    const entries = listGeminiSessionsFromDisk(DEFAULT_CWD, 30)
    if (entries.length === 0) {
      await ctx.reply(`current: \`${cur ?? '(none)'}\`\n\n(no persisted gemini sessions found for this project)`)
      return
    }
    // Find current session entry for the header preview.
    const curEntry = entries.find(e => e.sessionId === cur)
    const curPreview = curEntry?.title?.slice(0, 80) ?? '(no preview)'
    const lines = [
      `📍 *current*  \`${cur ?? '(none)'}\``,
      cur ? `   ${curPreview}` : '',
      '',
      `gemini sessions (${entries.length} shown, newest first):`,
      '',
    ].filter(Boolean)
    const ids: string[] = []
    // Buttons for the inline-keyboard companion to the text list. callback
    // data = `resume:<full-sessionId>`. Gemini sessionId is 36-char UUID →
    // "resume:" + 36 = 43 bytes, under TG's 64-byte cap.
    const btnRows: Array<Array<{ text: string; data: string }>> = []
    entries.forEach((s, i) => {
      ids.push(s.sessionId)
      const tag = s.sessionId === cur ? '  ← current' : ''
      const tsRaw = s.lastUpdated ?? new Date(s.mtimeMs).toISOString()
      const ts = tsRaw.slice(5, 16).replace('T', ' ')
      const msgs = s.msgCount != null ? `${s.msgCount}m` : '?'
      const title = (s.title ?? '(no user msg)').slice(0, 80)
      lines.push(`${i + 1}. ${ts}  ${msgs.padStart(5)}  ${title}${tag}`)
      lines.push(`   \`${s.sessionId}\``)
      const mark = s.sessionId === cur ? '📍' : '↩️'
      btnRows.push([{
        text: `${mark} #${i + 1} ${ts} ${title.slice(0, 30)}`,
        data: `resume:${s.sessionId}`,
      }])
    })
    lastListByChat.set(ctx.chatId, ids)
    lines.push(
      '',
      '👇 Tap a button to switch to that session (UUID passed directly).',
      'Or use `/resume <number>`, `/resume <full-sessionId>`, `/resume_last`.',
    )
    // Telegram inline_keyboard caps at 100 rows total — 30 max from our
    // entries-slice is well under.
    if (btnRows.length > 0) {
      await tg.sendWithButtons(ctx.chatId, lines.join('\n'), btnRows)
    } else {
      await ctx.reply(lines.join('\n'))
    }
  }

  slash.register('list', '', 'list recent gemini sessions (numbered; use /resume <number> to switch)', listSessionsHandler)
  // /sessions is a more-explicit alias people reach for, and avoids
  // confusion with generic "list" if other tools also register one.
  slash.register('sessions', '', 'alias of /list — show recent gemini sessions', listSessionsHandler)

  async function resumeByRef(ref: string, ctx: any): Promise<void> {
    let targetId = ref
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
    try {
      await gemini.sessionLoad(targetId, DEFAULT_CWD)
      await sessionMap.set(ctx.chatId, targetId)
      sessionToChat.set(targetId, ctx.chatId)
      loadedSessions.add(targetId)
      await ctx.reply(`✅ resumed \`${targetId}\` — gemini reloaded its message history; next prompt continues this thread.`)
    } catch (err) {
      await ctx.reply(`resume failed: ${(err as Error).message}\n\nrun \`/list\` to see valid ids.`)
    }
  }

  slash.register('resume', '<number|sessionId>', 'switch to a stored gemini session (number from /list or full id)', async (args, ctx) => {
    const a = args.trim()
    if (!a) {
      await ctx.reply('usage: `/resume <number>` (e.g. `/resume 2`), `/resume <sessionId>`, or `/resume_last`. Run `/list` first for the numbered list.')
      return
    }
    await resumeByRef(a, ctx)
  })

  slash.register('resume_last', '', 'switch to the most recent gemini session that you are NOT currently in', async (_args, ctx) => {
    // Auto-refresh cache first; cheap (just reads disk).
    const entries = listGeminiSessionsFromDisk(DEFAULT_CWD, 15)
    if (entries.length === 0) {
      await ctx.reply('no persisted gemini session found for this project.')
      return
    }
    lastListByChat.set(ctx.chatId, entries.map(e => e.sessionId))
    // Skip the session we're already in — common case is user opened
    // /new, exchanged nothing, and wants to go BACK to their previous
    // conversation. mtime-DESC would otherwise return the just-opened
    // empty one (it's now the newest) and /resume_last would be a no-op.
    const cur = sessionMap.get(ctx.chatId)
    const target = entries.find(e => e.sessionId !== cur)
    if (!target) {
      await ctx.reply('only one session exists (or you are already in the most recent one). nothing to switch to — try `/list` to pick a specific one or `/new` to start fresh.')
      return
    }
    await resumeByRef(target.sessionId, ctx)
  })

  slash.register('cancel', '', 'interrupt the currently running turn', async (_args, ctx) => {
    const sid = sessionMap.get(ctx.chatId)
    if (!sid) {
      await ctx.reply('no active session for this chat.')
      return
    }
    try {
      await gemini.sessionCancel(sid)
      await ctx.reply('⛔ cancel requested.')
    } catch (err) {
      await ctx.reply(`cancel failed: ${(err as Error).message}`)
    }
  })

  slash.register(
    'verbosity',
    '<quiet|normal|verbose>',
    "set per-chat reply verbosity. verbose = relay gemini's chain-of-thought (truncated, dim italics, coalesced 1.5s); normal/quiet = hide thoughts (current default)",
    async (args, ctx) => {
      const norm = args.trim().toLowerCase() as Verbosity | ''
      if (!norm) {
        const cur = getVerbosity(ctx.chatId)
        await ctx.reply(`current: \`${cur}\`. usage: \`/verbosity <quiet|normal|verbose>\``)
        return
      }
      if (norm !== 'quiet' && norm !== 'normal' && norm !== 'verbose') {
        await ctx.reply(`unknown level \`${norm}\`. options: quiet | normal | verbose`)
        return
      }
      chatVerbosity.set(ctx.chatId, norm)
      const desc = {
        quiet:   '🤫 quiet — hide thoughts + tool_call_update without content (default minus)',
        normal:  '🗣 normal — hide thoughts (default)',
        verbose: '🧠 verbose — relay thoughts truncated dim (1.5s coalesced)',
      }[norm]
      await ctx.reply(desc)
    },
  )

  slash.register('autoapprove', '<on|off>', 'toggle bridge auto-approve for this session', async (args, ctx) => {
    const sid = sessionMap.get(ctx.chatId)
    if (!sid) {
      await ctx.reply('no active session for this chat. send a normal message first to open one.')
      return
    }
    const norm = args.trim().toLowerCase()
    if (norm === 'on' || norm === 'true' || norm === '1') {
      autoApprove.add(sid)
      await ctx.reply('✋ auto-approve ON — bridge will silently accept every permission request for this session.')
    } else if (norm === 'off' || norm === 'false' || norm === '0') {
      autoApprove.delete(sid)
      await ctx.reply('🛂 auto-approve OFF — permission prompts will surface as usual.')
    } else {
      await ctx.reply(`status: ${autoApprove.has(sid) ? 'ON' : 'OFF'}. use \`/autoapprove on\` or \`/autoapprove off\`.`)
    }
  })

  slash.register('mode', '<default|autoEdit|yolo|plan>', 'switch gemini session mode (yolo = auto-approve everything)', async (args, ctx) => {
    const sid = sessionMap.get(ctx.chatId)
    if (!sid) {
      await ctx.reply('no active session. send a normal message first.')
      return
    }
    const norm = args.trim()
    if (!norm) {
      await ctx.reply('usage: `/mode <default|autoEdit|yolo|plan>`')
      return
    }
    try {
      await gemini.sessionSetMode(sid, norm)
      await ctx.reply(`🎛 session mode → \`${norm}\``)
    } catch (err) {
      await ctx.reply(`set_mode failed: ${(err as Error).message}`)
    }
  })

  slash.register('model', '<modelId>', 'switch gemini model for this session (e.g. gemini-3.1-pro-preview, auto-gemini-3)', async (args, ctx) => {
    const sid = sessionMap.get(ctx.chatId)
    if (!sid) {
      await ctx.reply('no active session. send a normal message first.')
      return
    }
    const norm = args.trim()
    if (!norm) {
      await ctx.reply('usage: `/model <id>`')
      return
    }
    try {
      await gemini.sessionSetModel(sid, norm)
      await ctx.reply(`🧠 session model → \`${norm}\``)
    } catch (err) {
      await ctx.reply(`set_model failed: ${(err as Error).message}`)
    }
  })

  slash.register('cmd', '<gemini slash-command>', 'forward to gemini (memory show / extensions list / init / restore list / ...)', async (args, ctx) => {
    let sid = sessionMap.get(ctx.chatId)
    if (!sid) {
      // Open a session first so gemini has somewhere to route the command.
      try {
        const r = await gemini.sessionNew(DEFAULT_CWD)
        sid = r.sessionId
        await sessionMap.set(ctx.chatId, sid)
        sessionToChat.set(sid, ctx.chatId)
      } catch (err) {
        await ctx.reply(`could not open session: ${(err as Error).message}`)
        return
      }
    }
    if (!args) {
      await ctx.reply("usage: `/cmd <gemini command>` — e.g. `/cmd memory show`, `/cmd init`, `/cmd restore list`")
      return
    }
    // gemini's prompt handler intercepts text starting with '/' or '$'
    // and routes it through its internal command dispatcher. So we send
    // the command as a regular prompt with the leading slash preserved.
    try {
      const text = args.startsWith('/') ? args : `/${args}`
      await gemini.sessionPrompt(sid, text)
      // No explicit reply here — gemini will stream the command output
      // back via the normal session/update channel.
    } catch (err) {
      await ctx.reply(`prompt-as-command failed: ${(err as Error).message}`)
    }
  })

  // Note: gemini-cli does NOT expose `session/fork` on its ACP wire
  // (verified 2026-05-16 — returns -32601 Method not found). To get
  // a parallel branch in gemini, the user has to run `/new` for a
  // fresh session and replay the prompt manually. We surface this as
  // a /-command so the help text explains the limitation.
  slash.register('fork', '', '(unsupported on gemini — use `/new` then replay)', async (_args, ctx) => {
    await ctx.reply(
      'gemini-cli does not expose `session/fork` on ACP. ' +
        'For a parallel branch, run `/new` (fresh session) then resend the prompt.',
    )
  })

  // --- inbound TG → gemini -----------------------------------------------
  tg.on('message', async (m: InboundMessage) => {
    log('info', `→ TG msg from chat=${m.chatId} user=${m.username}: ${m.text.slice(0, 80)}`)

    // Bridge-managed slash commands (`/help`, `/mode`, `/cmd`, etc.)
    // get dispatched before we forward anything to gemini. If a
    // command is matched, the inbound message is NOT sent as a prompt.
    if (m.text && m.text.trim().startsWith('/') && m.attachments.length === 0) {
      const handled = await slash.dispatch(m.text, {
        chatId: m.chatId,
        reply: (t: string) => tg.reply(m.chatId, t, m.messageId),
        log,
      })
      if (handled) return
    }

    let sessionId = sessionMap.get(m.chatId)

    if (!sessionId) {
      // Fresh session for this chat.
      try {
        const r = await gemini.sessionNew(DEFAULT_CWD)
        sessionId = r.sessionId
        await sessionMap.set(m.chatId, sessionId)
        sessionToChat.set(sessionId, m.chatId)
        loadedSessions.add(sessionId)
        log('info', `session/new chat=${m.chatId} sessionId=${sessionId.slice(0, 8)}`)
      } catch (err) {
        log('error', `session/new failed: ${(err as Error).message}`)
        await tg.reply(m.chatId, `❌ gemini session/new failed: ${(err as Error).message}`)
        return
      }
    } else {
      sessionToChat.set(sessionId, m.chatId)
      // Stored sessionId from a prior bridge boot — the live gemini
      // process doesn't know about it yet. Reattach via session/load
      // so it can resume message history before we send the prompt.
      // session/new auto-attaches; session/load is the only way to
      // pick up a persisted session from disk on the wire.
      if (!loadedSessions.has(sessionId)) {
        try {
          await gemini.sessionLoad(sessionId, DEFAULT_CWD)
          loadedSessions.add(sessionId)
          log('info', `session/load chat=${m.chatId} sessionId=${sessionId.slice(0, 8)} (restored)`)
        } catch (err) {
          // Persisted id no longer valid (gemini's project hash
          // changed, or disk-side session was deleted). Drop the
          // mapping and fall back to a fresh session.
          log(
            'warn',
            `session/load failed for ${sessionId.slice(0, 8)} (${(err as Error).message}); falling back to session/new`,
          )
          await sessionMap.clear(m.chatId)
          try {
            const r = await gemini.sessionNew(DEFAULT_CWD)
            sessionId = r.sessionId
            await sessionMap.set(m.chatId, sessionId)
            sessionToChat.set(sessionId, m.chatId)
            loadedSessions.add(sessionId)
            log('info', `session/new (load-fallback) chat=${m.chatId} sessionId=${sessionId.slice(0, 8)}`)
          } catch (err2) {
            log('error', `session/new fallback failed: ${(err2 as Error).message}`)
            await tg.reply(m.chatId, `❌ gemini session/new failed: ${(err2 as Error).message}`)
            return
          }
        }
      }
    }

    // Post ⛔ Stop button so the user can interrupt long-running turns.
    const cancelRef = randomBytes(3).toString('hex')
    cancelRefToSession.set(cancelRef, sessionId)
    try {
      const stopMsgId = await tg.sendWithButtons(m.chatId, '⏳ gemini is working…', [
        [{ text: '⛔ Stop', data: `cancel:${cancelRef}` }],
      ])
      stopMessageBySession.set(sessionId, { chatId: m.chatId, messageId: stopMsgId })
    } catch (err) {
      log('warn', `failed to post stop button: ${(err as Error).message}`)
    }

    // Audit rule #3: raw text + raw ACP content blocks for any attached
    // images / audio / documents. attachmentsToAcpContent does no
    // wrapping — it maps the Attachment[] one-to-one to ContentBlock[]
    // (base64-encoding images / audio for the wire).
    try {
      const prompt = await attachmentsToAcpContent(m.text, m.attachments)
      const att = m.attachments.length
        ? ` attachments=[${m.attachments.map(a => a.kind).join(',')}]`
        : ''

      let response: { stopReason?: string }
      try {
        const promise = gemini.sessionPrompt(sessionId, prompt)
        activeTurnPromises.set(sessionId, promise)
        log('info', `session/prompt chat=${m.chatId} session=${sessionId.slice(0, 8)} prompt.blocks=${prompt.length}${att}`)
        response = (await promise) as { stopReason?: string }
      } catch (err) {
        // Session was lost (most often after `gemini --acp` restart —
        // sessions are in-process state with no persistence). Fall back
        // to a fresh session and retry the prompt once.
        const msg = (err as Error).message
        const sessionLost =
          msg.includes('Session not found') ||
          msg.includes('session not found') ||
          msg.includes('unknown sessionId')
        if (!sessionLost) throw err
        log('warn', `session ${sessionId.slice(0, 8)} lost (likely after gemini restart); opening fresh session`)
        activeTurnPromises.delete(sessionId)
        await sessionMap.clear(m.chatId)
        const fresh = await gemini.sessionNew(DEFAULT_CWD)
        const newSessionId = fresh.sessionId
        await sessionMap.set(m.chatId, newSessionId)
        sessionToChat.delete(sessionId)
        sessionToChat.set(newSessionId, m.chatId)
        loadedSessions.delete(sessionId)
        loadedSessions.add(newSessionId)
        // The auto-approve flag is session-scoped — when we transparently
        // open a fresh session, carry the user's intent forward so they
        // don't have to click the toggle again after every restart.
        if (autoApprove.delete(sessionId)) autoApprove.add(newSessionId)
        log('info', `session/new (auto-recovery) chat=${m.chatId} sessionId=${newSessionId.slice(0, 8)}`)
        // Rebind cancel ref + stop message to the new session id so the
        // ⛔ button still works.
        if (cancelRefToSession.get(cancelRef) === sessionId) {
          cancelRefToSession.set(cancelRef, newSessionId)
        }
        const stop = stopMessageBySession.get(sessionId)
        if (stop) {
          stopMessageBySession.delete(sessionId)
          stopMessageBySession.set(newSessionId, stop)
        }
        sessionId = newSessionId
        const retryPromise = gemini.sessionPrompt(sessionId, prompt)
        activeTurnPromises.set(sessionId, retryPromise)
        log('info', `session/prompt retry chat=${m.chatId} session=${sessionId.slice(0, 8)} prompt.blocks=${prompt.length}${att}`)
        response = (await retryPromise) as { stopReason?: string }
      }

      activeTurnPromises.delete(sessionId)
      // Reset tool-loop alert state for the next turn.
      turnToolCallCount.delete(sessionId)
      turnAlertSent.delete(sessionId)
      log('info', `session/prompt complete chat=${m.chatId} stopReason=${response?.stopReason ?? '?'}`)
      // Remove the cancel ref + tidy the Stop message.
      cancelRefToSession.delete(cancelRef)
      const stop = stopMessageBySession.get(sessionId)
      if (stop) {
        stopMessageBySession.delete(sessionId)
        void tg
          .editMessage(stop.chatId, stop.messageId, `✓ gemini complete (${response?.stopReason ?? 'end_turn'})`)
          .catch(() => {})
        void tg.clearButtons(stop.chatId, stop.messageId).catch(() => {})
      }
      // Finalize streaming consumer for this turn.
      const consumer = turnConsumers.get(sessionId)
      if (consumer) {
        consumer.finish()
        turnConsumers.delete(sessionId)
      }
    } catch (err) {
      log('error', `session/prompt failed: ${(err as Error).message}`)
      activeTurnPromises.delete(sessionId)
      turnToolCallCount.delete(sessionId)
      turnAlertSent.delete(sessionId)
      cancelRefToSession.delete(cancelRef)
      const stop = stopMessageBySession.get(sessionId)
      if (stop) {
        stopMessageBySession.delete(sessionId)
        void tg
          .editMessage(stop.chatId, stop.messageId, `❌ gemini turn failed`)
          .catch(() => {})
        void tg.clearButtons(stop.chatId, stop.messageId).catch(() => {})
      }
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
