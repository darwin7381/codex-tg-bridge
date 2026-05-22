/**
 * Telegram side of the bridge.
 *
 * Pattern mirrors the telegram-http plugin's access-control + ackReaction
 * conventions for consistency (so administrators using both can manage
 * allowlists with the same mental model).
 *
 * Reads access policy from $STATE_DIR/access.json:
 *   {
 *     "dmPolicy": "approved-only" | "pairing" | "open",
 *     "ackReaction": "👀",
 *     "approved": [{ "user_id": "1828173984", ... }]
 *   }
 *
 * Inbound message surface:
 *   - text  — plain text (the original case)
 *   - photo / voice / audio / document / video / animation / sticker —
 *     downloaded via AttachmentStore to $STATE_DIR/inbox/, surfaced as
 *     `attachments[]` on the InboundMessage. The agent layer decides how
 *     to render each kind (image → localImage, audio → transcribe or
 *     native, doc → inline or mention, etc.).
 *
 * Outbound surface:
 *   - reply (text), editMessage, react (emoji), sendWithButtons (inline kb),
 *     sendPhoto (with optional caption), sendDocument (with optional caption).
 */

import { Bot, type Context, GrammyError, InlineKeyboard, InputFile } from 'grammy'
import { readFile } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { AttachmentStore } from './attachment-store.ts'

export type AccessPolicy = {
  dmPolicy?: 'approved-only' | 'pairing' | 'open'
  ackReaction?: string
  approved?: Array<{ user_id: string; username?: string }>
}

export type AttachmentKind =
  | 'image'
  | 'voice'
  | 'audio'
  | 'document'
  | 'video'
  | 'animation'
  | 'sticker'

export type Attachment = {
  kind: AttachmentKind
  /** Absolute path to the downloaded file in $STATE_DIR/inbox. */
  path: string
  /** Bytes on disk after download. */
  size: number
  /** Best-effort MIME from Telegram (sender-supplied; do not trust blindly). */
  mime?: string
  /** Original filename if Telegram gave one. */
  name?: string
  /** For audio / video / voice / animation, duration in seconds. */
  duration?: number
  /** Optional thumbnail (file_id reference; not downloaded by default). */
  thumbFileId?: string
}

export type InboundMessage = {
  chatId: string
  messageId: number
  userId: string
  username: string
  /** Free text. For media messages this is the caption (may be empty). */
  text: string
  /** Files / media attached to this message, in TG order. */
  attachments: Attachment[]
  /** When this message is a reply to a previous one, that message id. */
  replyToMessageId?: number
  /** Telegram timestamp ISO-8601. */
  ts: string
}

export class TelegramClient extends EventEmitter {
  private bot: Bot
  private access: AccessPolicy = {}
  private accessLoadedAt = 0
  private readonly token: string
  private readonly attachments: AttachmentStore

  constructor(
    token: string,
    private readonly stateDir: string,
  ) {
    super()
    this.token = token
    this.bot = new Bot(token)
    this.attachments = new AttachmentStore(stateDir)

    // All inbound message types funnel through one handler. grammy emits
    // discrete events per content type — we subscribe to each so we can
    // collect attachments before emitting the unified InboundMessage.
    this.bot.on('message:text', ctx => this.safeHandle(ctx, []))
    this.bot.on('message:photo', ctx => this.handlePhoto(ctx))
    this.bot.on('message:voice', ctx => this.handleVoice(ctx))
    this.bot.on('message:audio', ctx => this.handleAudio(ctx))
    this.bot.on('message:document', ctx => this.handleDocument(ctx))
    this.bot.on('message:video', ctx => this.handleVideo(ctx))
    this.bot.on('message:animation', ctx => this.handleAnimation(ctx))
    this.bot.on('message:sticker', ctx => this.handleSticker(ctx))

    // Inline-button clicks for approval prompts. callback_data follows
    // the shape `appr:<cbId>:<decision>` or `cancel:<turnRef>`.
    this.bot.on('callback_query:data', async ctx => {
      const data = ctx.callbackQuery.data
      if (!data) {
        await ctx.answerCallbackQuery().catch(() => {})
        return
      }
      // Reload access — same as inbound messages — and only honour
      // callbacks from allowlisted users.
      if (Date.now() - this.accessLoadedAt > 5000) await this.reloadAccess()
      const fromId = ctx.from?.id
      if (!fromId || !this.isAllowed(String(fromId))) {
        await ctx.answerCallbackQuery({ text: 'not authorized', show_alert: true }).catch(() => {})
        return
      }
      if (data.startsWith('appr:')) {
        const parts = data.split(':')
        if (parts.length !== 3) {
          await ctx.answerCallbackQuery({ text: 'malformed callback_data' }).catch(() => {})
          return
        }
        const [, cbId, decision] = parts
        this.emit('approval', {
          cbId,
          decision,
          chatId: String(ctx.chat?.id ?? ''),
          messageId: ctx.callbackQuery.message?.message_id,
          userId: String(fromId),
        })
        await ctx.answerCallbackQuery({ text: `${decision}` }).catch(() => {})
        return
      }
      if (data.startsWith('cancel:')) {
        const ref = data.slice('cancel:'.length)
        this.emit('cancel', {
          ref,
          chatId: String(ctx.chat?.id ?? ''),
          messageId: ctx.callbackQuery.message?.message_id,
        })
        await ctx.answerCallbackQuery({ text: '⛔ cancelling…' }).catch(() => {})
        return
      }
      await ctx.answerCallbackQuery().catch(() => {})
    })

    this.bot.catch(err => this.emit('error', err))
  }

  async start(): Promise<{ username: string }> {
    await this.reloadAccess()
    const me = await this.bot.api.getMe()
    this.attachments.startGC((level, msg) =>
      this.emit(level === 'info' ? 'gc-info' : 'gc-warn', msg),
    )
    void this.bot.start({
      onStart: () => {
        this.emit('ready')
      },
      drop_pending_updates: false,
    })
    return { username: me.username ?? '' }
  }

  async stop(): Promise<void> {
    this.attachments.stopGC()
    await this.bot.stop()
  }

  /**
   * Register the bot's slash-command suggestions with Telegram so the
   * native client pops up an autocomplete menu when the user types `/`.
   * Without this, the SlashCommandRouter still works (typing the full
   * command and sending dispatches it), but there is no UI hint.
   *
   * Bot API: https://core.telegram.org/bots/api#setmycommands
   *
   * Registers to TWO scopes:
   *   - default (catches anywhere a more specific scope isn't set)
   *   - all_private_chats (overrides any BotFather-era leftover commands
   *     that would otherwise be shown in private DMs)
   *
   * Without the all_private_chats override, a bot that had BotFather
   * placeholder commands set (e.g. /start /help /status) would show
   * THOSE in private chats instead of ours — even though our default-
   * scope registration is valid. Telegram client picks the most-specific
   * scope first per https://core.telegram.org/bots/api#botcommandscope.
   */
  async setMyCommands(
    commands: ReadonlyArray<{ command: string; description: string }>,
  ): Promise<void> {
    // Telegram caps the list at 100 and requires each command match
    // /^[a-z0-9_]{1,32}$/. The caller already filters, but be defensive.
    const filtered = commands
      .filter(c => /^[a-z0-9_]{1,32}$/.test(c.command))
      .map(c => ({
        command: c.command,
        description: (c.description || '(no description)').slice(0, 256),
      }))
      .slice(0, 100)
    // Default scope — catches anywhere no more specific scope is set.
    await this.bot.api.setMyCommands(filtered)
    // all_private_chats scope — overrides BotFather-era leftover commands
    // in DMs. Same command list; just makes sure private-chat clients
    // pick up our list instead of any older configuration.
    await this.bot.api.setMyCommands(filtered, { scope: { type: 'all_private_chats' } })
  }

  // --- inbound handlers ---------------------------------------------------

  private async safeHandle(ctx: Context, attachments: Attachment[]): Promise<void> {
    try {
      await this.emitInbound(ctx, attachments)
    } catch (err) {
      this.emit('error', err)
    }
  }

  private async emitInbound(ctx: Context, attachments: Attachment[]): Promise<void> {
    const from = ctx.from
    const chat = ctx.chat
    const msgId = ctx.message?.message_id
    const text = ctx.message?.text ?? ctx.message?.caption ?? ''
    const replyTo = ctx.message?.reply_to_message?.message_id

    if (!from || !chat || msgId == null) return

    if (Date.now() - this.accessLoadedAt > 5000) await this.reloadAccess()
    if (!this.isAllowed(String(from.id))) return // quiet reject

    const ack = this.access.ackReaction
    if (ack) {
      this.bot.api
        .setMessageReaction(chat.id, msgId, [{ type: 'emoji', emoji: ack as any }])
        .catch(() => {})
    }

    const inbound: InboundMessage = {
      chatId: String(chat.id),
      messageId: msgId,
      userId: String(from.id),
      username: from.username ?? String(from.id),
      text,
      attachments,
      replyToMessageId: replyTo,
      ts: new Date((ctx.message?.date ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
    }
    this.emit('message', inbound)
  }

  private async handlePhoto(ctx: Context): Promise<void> {
    const photos = ctx.message?.photo
    if (!photos || photos.length === 0) {
      await this.safeHandle(ctx, [])
      return
    }
    // Telegram delivers an array of size variants; the last one is the
    // highest resolution.
    const best = photos[photos.length - 1]
    const msgId = ctx.message?.message_id ?? 0
    try {
      const { path, bytes } = await this.attachments.fetchTelegramFile({
        token: this.token,
        fileId: best.file_id,
        messageId: msgId,
        mime: 'image/jpeg',
      })
      await this.safeHandle(ctx, [{ kind: 'image', path, size: bytes, mime: 'image/jpeg' }])
    } catch (err) {
      this.emit('error', new Error(`photo download failed: ${(err as Error).message}`))
      await this.safeHandle(ctx, [])
    }
  }

  private async handleVoice(ctx: Context): Promise<void> {
    const v = ctx.message?.voice
    if (!v) {
      await this.safeHandle(ctx, [])
      return
    }
    const msgId = ctx.message?.message_id ?? 0
    try {
      const { path, bytes } = await this.attachments.fetchTelegramFile({
        token: this.token,
        fileId: v.file_id,
        messageId: msgId,
        mime: v.mime_type ?? 'audio/ogg',
      })
      await this.safeHandle(ctx, [
        { kind: 'voice', path, size: bytes, mime: v.mime_type, duration: v.duration },
      ])
    } catch (err) {
      this.emit('error', new Error(`voice download failed: ${(err as Error).message}`))
      await this.safeHandle(ctx, [])
    }
  }

  private async handleAudio(ctx: Context): Promise<void> {
    const a = ctx.message?.audio
    if (!a) {
      await this.safeHandle(ctx, [])
      return
    }
    const msgId = ctx.message?.message_id ?? 0
    try {
      const { path, bytes } = await this.attachments.fetchTelegramFile({
        token: this.token,
        fileId: a.file_id,
        messageId: msgId,
        suggestedName: a.file_name,
        mime: a.mime_type,
      })
      await this.safeHandle(ctx, [
        {
          kind: 'audio',
          path,
          size: bytes,
          mime: a.mime_type,
          name: a.file_name,
          duration: a.duration,
        },
      ])
    } catch (err) {
      this.emit('error', new Error(`audio download failed: ${(err as Error).message}`))
      await this.safeHandle(ctx, [])
    }
  }

  private async handleDocument(ctx: Context): Promise<void> {
    const d = ctx.message?.document
    if (!d) {
      await this.safeHandle(ctx, [])
      return
    }
    const msgId = ctx.message?.message_id ?? 0
    try {
      const { path, bytes } = await this.attachments.fetchTelegramFile({
        token: this.token,
        fileId: d.file_id,
        messageId: msgId,
        suggestedName: d.file_name,
        mime: d.mime_type,
      })
      await this.safeHandle(ctx, [
        {
          kind: 'document',
          path,
          size: bytes,
          mime: d.mime_type,
          name: d.file_name,
        },
      ])
    } catch (err) {
      this.emit('error', new Error(`document download failed: ${(err as Error).message}`))
      await this.safeHandle(ctx, [])
    }
  }

  private async handleVideo(ctx: Context): Promise<void> {
    const v = ctx.message?.video
    if (!v) {
      await this.safeHandle(ctx, [])
      return
    }
    const msgId = ctx.message?.message_id ?? 0
    try {
      const { path, bytes } = await this.attachments.fetchTelegramFile({
        token: this.token,
        fileId: v.file_id,
        messageId: msgId,
        suggestedName: v.file_name,
        mime: v.mime_type ?? 'video/mp4',
      })
      await this.safeHandle(ctx, [
        {
          kind: 'video',
          path,
          size: bytes,
          mime: v.mime_type ?? 'video/mp4',
          name: v.file_name,
          duration: v.duration,
        },
      ])
    } catch (err) {
      this.emit('error', new Error(`video download failed: ${(err as Error).message}`))
      await this.safeHandle(ctx, [])
    }
  }

  private async handleAnimation(ctx: Context): Promise<void> {
    const a = ctx.message?.animation
    if (!a) {
      await this.safeHandle(ctx, [])
      return
    }
    const msgId = ctx.message?.message_id ?? 0
    try {
      const { path, bytes } = await this.attachments.fetchTelegramFile({
        token: this.token,
        fileId: a.file_id,
        messageId: msgId,
        suggestedName: a.file_name,
        mime: a.mime_type ?? 'video/mp4',
      })
      await this.safeHandle(ctx, [
        {
          kind: 'animation',
          path,
          size: bytes,
          mime: a.mime_type ?? 'video/mp4',
          name: a.file_name,
          duration: a.duration,
        },
      ])
    } catch (err) {
      this.emit('error', new Error(`animation download failed: ${(err as Error).message}`))
      await this.safeHandle(ctx, [])
    }
  }

  /**
   * Stickers are rendered as text: animated/video sticker → emoji label
   * only (we don't download the .webp/.tgs). The emoji that the sticker
   * represents is sent in the text so the agent can react to it.
   */
  private async handleSticker(ctx: Context): Promise<void> {
    const s = ctx.message?.sticker
    if (!s) {
      await this.safeHandle(ctx, [])
      return
    }
    const tag = `[sticker ${s.emoji ?? ''} from "${s.set_name ?? 'unknown'}"]`
    // Build a synthetic InboundMessage with text = tag; no attachments.
    // We have to do this manually because safeHandle reads ctx.message.text
    // (we want to override it).
    const from = ctx.from
    const chat = ctx.chat
    const msgId = ctx.message?.message_id
    if (!from || !chat || msgId == null) return
    if (Date.now() - this.accessLoadedAt > 5000) await this.reloadAccess()
    if (!this.isAllowed(String(from.id))) return
    const ack = this.access.ackReaction
    if (ack) {
      this.bot.api
        .setMessageReaction(chat.id, msgId, [{ type: 'emoji', emoji: ack as any }])
        .catch(() => {})
    }
    const inbound: InboundMessage = {
      chatId: String(chat.id),
      messageId: msgId,
      userId: String(from.id),
      username: from.username ?? String(from.id),
      text: tag,
      attachments: [],
      replyToMessageId: ctx.message?.reply_to_message?.message_id,
      ts: new Date((ctx.message?.date ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
    }
    this.emit('message', inbound)
  }

  // --- access control + state ---------------------------------------------

  private isAllowed(userId: string): boolean {
    const policy = this.access.dmPolicy ?? 'approved-only'
    if (policy === 'open') return true
    const approved = this.access.approved ?? []
    return approved.some(a => a.user_id === userId)
  }

  private async reloadAccess(): Promise<void> {
    try {
      const raw = await readFile(`${this.stateDir}/access.json`, 'utf8')
      this.access = JSON.parse(raw)
    } catch {
      this.access = {}
    }
    this.accessLoadedAt = Date.now()
  }

  // --- outbound ------------------------------------------------------------

  /**
   * Send a fresh reply. If `text` exceeds Telegram's 4096-char limit it
   * is split across multiple messages with continuation markers; the
   * returned message_id is the FIRST chunk so the caller can edit /
   * delete / react against it.
   */
  async reply(chatId: string, text: string, replyTo?: number): Promise<number> {
    const chunks = splitForTelegram(text)
    let firstId = -1
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks.length > 1 ? `${chunks[i]}\n\n[${i + 1}/${chunks.length}]` : chunks[i]
      const sent = await this.bot.api.sendMessage(chatId, chunk, {
        reply_parameters: i === 0 && replyTo ? { message_id: replyTo } : undefined,
      })
      if (i === 0) firstId = sent.message_id
    }
    return firstId
  }

  /**
   * Edit an existing message — used for streaming updates within a turn.
   * Edits do not trigger push notifications. Auto-truncates at 4000 chars
   * so we never overflow Telegram's limit mid-stream.
   */
  async editMessage(chatId: string, messageId: number, text: string): Promise<void> {
    try {
      await this.bot.api.editMessageText(chatId, messageId, text.slice(0, 4000))
    } catch (err) {
      if (err instanceof GrammyError && err.description.includes('not modified')) return
      throw err
    }
  }

  /**
   * Edit an existing message's reply_markup only (e.g. remove approval
   * buttons after a decision is made).
   */
  async clearButtons(chatId: string, messageId: number): Promise<void> {
    try {
      await this.bot.api.editMessageReplyMarkup(chatId, messageId, { reply_markup: undefined })
    } catch {
      // ignore — common race when the click handler already edited the msg
    }
  }

  async react(chatId: string, messageId: number, emoji: string): Promise<void> {
    try {
      await this.bot.api.setMessageReaction(chatId, messageId, [
        { type: 'emoji', emoji: emoji as any },
      ])
    } catch {
      // emoji whitelist rejects — swallow
    }
  }

  async sendWithButtons(
    chatId: string,
    text: string,
    buttons: ReadonlyArray<ReadonlyArray<{ text: string; data: string }>>,
  ): Promise<number> {
    const kb = new InlineKeyboard()
    buttons.forEach((row, rowIdx) => {
      row.forEach(btn => kb.text(btn.text, btn.data))
      if (rowIdx < buttons.length - 1) kb.row()
    })
    const sent = await this.bot.api.sendMessage(chatId, text, { reply_markup: kb })
    return sent.message_id
  }

  /** Send a local image file as a Telegram photo (with optional caption). */
  async sendPhoto(chatId: string, path: string, caption?: string): Promise<number> {
    const sent = await this.bot.api.sendPhoto(chatId, new InputFile(path), {
      caption: caption?.slice(0, 1024),
    })
    return sent.message_id
  }

  /** Send a local file as a Telegram document (with optional caption). */
  async sendDocument(chatId: string, path: string, caption?: string): Promise<number> {
    const sent = await this.bot.api.sendDocument(chatId, new InputFile(path), {
      caption: caption?.slice(0, 1024),
    })
    return sent.message_id
  }
}

/**
 * Split text on paragraph / line boundaries so each chunk fits within
 * Telegram's 4096-char limit (we use a 3800 budget to leave room for the
 * "[i/n]" continuation marker).
 */
function splitForTelegram(text: string, maxLen = 3800): string[] {
  if (text.length <= maxLen) return [text]
  const out: string[] = []
  let buf = ''
  for (const line of text.split('\n')) {
    if (buf.length + line.length + 1 > maxLen) {
      if (buf) out.push(buf)
      // Single line longer than budget — hard split.
      if (line.length > maxLen) {
        for (let i = 0; i < line.length; i += maxLen) {
          out.push(line.slice(i, i + maxLen))
        }
        buf = ''
      } else {
        buf = line
      }
    } else {
      buf = buf ? `${buf}\n${line}` : line
    }
  }
  if (buf) out.push(buf)
  return out
}
