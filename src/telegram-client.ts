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
 * No claim to feature-parity with the official Telegram plugin — this
 * client only implements the surface the bridge needs.
 */

import { Bot, type Context, GrammyError } from 'grammy'
import { readFile } from 'node:fs/promises'
import { EventEmitter } from 'node:events'

export type AccessPolicy = {
  dmPolicy?: 'approved-only' | 'pairing' | 'open'
  ackReaction?: string
  approved?: Array<{ user_id: string; username?: string }>
}

export type InboundMessage = {
  chatId: string
  messageId: number
  userId: string
  username: string
  text: string
  ts: string
}

export class TelegramClient extends EventEmitter {
  private bot: Bot
  private access: AccessPolicy = {}
  private accessLoadedAt = 0

  constructor(
    token: string,
    private readonly stateDir: string,
  ) {
    super()
    this.bot = new Bot(token)

    this.bot.on('message:text', async ctx => {
      try {
        await this.handleTextMessage(ctx)
      } catch (err) {
        this.emit('error', err)
      }
    })

    this.bot.catch(err => this.emit('error', err))
  }

  async start(): Promise<{ username: string }> {
    await this.reloadAccess()
    const me = await this.bot.api.getMe()
    // grammy's start() blocks; we want a promise that resolves once polling
    // is up so the caller can log "ready". We do that by waiting for the
    // initial getUpdates round trip via bot.api.getMe() above, then kick
    // off long-polling in the background.
    void this.bot.start({
      onStart: () => {
        this.emit('ready')
      },
      drop_pending_updates: false,
    })
    return { username: me.username ?? '' }
  }

  async stop(): Promise<void> {
    await this.bot.stop()
  }

  private async handleTextMessage(ctx: Context): Promise<void> {
    const text = ctx.message?.text
    const from = ctx.from
    const chat = ctx.chat
    const msgId = ctx.message?.message_id
    if (!text || !from || !chat || msgId == null) return

    // Reload access policy on every message — cheap, keeps allowlist edits
    // hot without restarting the daemon. Throttle to once per 5s.
    if (Date.now() - this.accessLoadedAt > 5000) await this.reloadAccess()

    if (!this.isAllowed(String(from.id))) {
      // Quiet rejection — don't leak which IDs are allowed.
      return
    }

    const ack = this.access.ackReaction
    if (ack) {
      this.bot.api
        .setMessageReaction(chat.id, msgId, [{ type: 'emoji', emoji: ack as any }])
        .catch(() => {
          // Telegram only accepts a fixed emoji whitelist; swallow rejects.
        })
    }

    const inbound: InboundMessage = {
      chatId: String(chat.id),
      messageId: msgId,
      userId: String(from.id),
      username: from.username ?? String(from.id),
      text,
      ts: new Date((ctx.message?.date ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
    }
    this.emit('message', inbound)
  }

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

  /**
   * Send a fresh reply to a chat. Returns the new message id.
   */
  async reply(chatId: string, text: string, replyTo?: number): Promise<number> {
    const sent = await this.bot.api.sendMessage(chatId, text, {
      reply_parameters: replyTo ? { message_id: replyTo } : undefined,
    })
    return sent.message_id
  }

  /**
   * Edit an existing message — used for streaming updates within a turn.
   * Edits do not trigger push notifications, matching telegram-http's
   * "stream while you think, ping only on completion" UX.
   */
  async editMessage(chatId: string, messageId: number, text: string): Promise<void> {
    try {
      await this.bot.api.editMessageText(chatId, messageId, text)
    } catch (err) {
      // Common: "message is not modified" when delta matches; safe to swallow.
      if (err instanceof GrammyError && err.description.includes('not modified')) return
      throw err
    }
  }

  /**
   * React with an emoji on an inbound message. Used to indicate "done"
   * once a turn completes.
   */
  async react(chatId: string, messageId: number, emoji: string): Promise<void> {
    try {
      await this.bot.api.setMessageReaction(chatId, messageId, [
        { type: 'emoji', emoji: emoji as any },
      ])
    } catch {
      // Telegram emoji whitelist rejects; swallow.
    }
  }
}
