/**
 * Slash command dispatcher shared by the codex and gemini bridges.
 *
 * Inbound TG messages whose text starts with `/` (and isn't a generic
 * URL or path prefix) are intercepted *before* being sent to the agent
 * as a prompt. Each registered command receives the parsed `name` and
 * `args` string and a `ctx` callback bag (chat reply, log, etc.).
 *
 * Commands that affect bridge state (session map, auto-approve toggle,
 * cancellation) are universal. Commands that touch agent behaviour
 * (`/mode`, `/model`, `/cmd`) are wired only in the gemini bridge for
 * now because codex's app-server protocol doesn't expose equivalents
 * (codex personality + reasoning effort live in `~/.codex/config.toml`
 * and apply on thread/start, not per-turn).
 */

type Reply = (text: string) => Promise<unknown> | unknown
type LogFn = (level: 'info' | 'warn' | 'error', msg: string) => void

export type SlashContext = {
  chatId: string
  reply: Reply
  log: LogFn
}

export type SlashHandler = (args: string, ctx: SlashContext) => Promise<void> | void

export class SlashCommandRouter {
  private commands = new Map<
    string,
    { handler: SlashHandler; usage: string; description: string }
  >()

  register(name: string, usage: string, description: string, handler: SlashHandler): void {
    this.commands.set(name.toLowerCase(), { handler, usage, description })
  }

  /**
   * Snapshot of registered commands in a shape compatible with Telegram's
   * Bot API `setMyCommands`: `[{ command, description }, ...]`. Telegram
   * requires command names match `^[a-z0-9_]{1,32}$` and descriptions
   * length 1-256.
   */
  listForBotApi(): Array<{ command: string; description: string }> {
    const out: Array<{ command: string; description: string }> = []
    // `/help` is implicit in dispatch() but not in the map — surface it.
    out.push({ command: 'help', description: 'show available slash commands' })
    for (const [name, { description }] of [...this.commands.entries()].sort()) {
      if (!/^[a-z0-9_]{1,32}$/.test(name)) continue
      out.push({ command: name, description: description.slice(0, 256) })
    }
    return out
  }

  /** Returns `true` if `text` looked like a slash command and was dispatched
   *  (regardless of whether the command itself succeeded). */
  async dispatch(text: string, ctx: SlashContext): Promise<boolean> {
    const m = /^\/([a-z][a-z0-9_-]*)(?:\s+(.*))?\s*$/i.exec(text.trim())
    if (!m) return false
    const name = m[1].toLowerCase()
    const args = (m[2] ?? '').trim()
    if (name === 'help') {
      await this.showHelp(ctx)
      return true
    }
    const entry = this.commands.get(name)
    if (!entry) {
      await ctx.reply(`❓ unknown slash command: \`/${name}\`. type /help for the list.`)
      return true
    }
    try {
      await entry.handler(args, ctx)
    } catch (err) {
      ctx.log('warn', `slash /${name} failed: ${(err as Error).message}`)
      await ctx.reply(`❌ /${name} failed: ${(err as Error).message}`)
    }
    return true
  }

  private async showHelp(ctx: SlashContext): Promise<void> {
    const lines: string[] = ['**Available slash commands**', '', '`/help` — show this message']
    for (const [name, { usage, description }] of [...this.commands.entries()].sort()) {
      lines.push(`\`/${name}${usage ? ' ' + usage : ''}\` — ${description}`)
    }
    await ctx.reply(lines.join('\n'))
  }
}
