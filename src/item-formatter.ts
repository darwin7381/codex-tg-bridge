/**
 * Format a codex ThreadItem into a Telegram-readable text block.
 *
 * Audit rule #4: we render every item type we know about, so users see the
 * same agent surface they would in the vanilla codex TUI (thinking, plan,
 * shell command output, file changes, MCP calls, web search, etc.). No
 * item type is silently dropped — unknown types fall through to a generic
 * dump so the user still sees that *something* happened, and we get a
 * signal to add explicit rendering for it later.
 */

import type { ThreadItem } from './codex-client.ts'

const MAX_OUTPUT = 3500 // Telegram message hard limit is 4096; keep margin.

function truncate(s: string, n = MAX_OUTPUT): string {
  if (s.length <= n) return s
  return s.slice(0, n - 20) + `\n…(+${s.length - n} chars)`
}

export function formatItem(item: ThreadItem): string | null {
  switch (item.type) {
    case 'userMessage':
      // Echo of the user's own message — don't relay back to TG (would be
      // noise; the user just sent it).
      return null

    case 'agentMessage': {
      const text = (item as any).text as string
      return truncate(text)
    }

    case 'reasoning': {
      const summary = ((item as any).summary as string[]) ?? []
      if (summary.length === 0) return null
      return truncate(`🤔 ${summary.join('\n')}`)
    }

    case 'plan': {
      const text = (item as any).text as string
      return truncate(`📋 plan:\n${text}`)
    }

    case 'commandExecution': {
      const i = item as any
      const status = i.status ?? '?'
      const cmd = i.command ?? '?'
      const out = i.aggregatedOutput ?? ''
      const exit = i.exitCode
      const dur = i.durationMs
      const head = `⌨️ \`${cmd}\``
      const meta =
        status === 'completed'
          ? ` (exit=${exit}${dur != null ? `, ${dur}ms` : ''})`
          : ` (${status})`
      const body = out ? `\n${truncate(out, 2500)}` : ''
      return truncate(head + meta + body)
    }

    case 'fileChange': {
      const i = item as any
      const changes = (i.changes ?? []) as Array<any>
      const lines = changes.map(c => {
        const kind = c.type ?? 'change'
        const path = c.path ?? '?'
        return `  ${kind}: ${path}`
      })
      return truncate(`📝 fileChange (${i.status ?? '?'})\n${lines.join('\n')}`)
    }

    case 'mcpToolCall': {
      const i = item as any
      const head = `🔌 mcp ${i.server}/${i.tool} (${i.status ?? '?'})`
      const args = JSON.stringify(i.arguments ?? {}, null, 2)
      const result = i.result ? `\nresult: ${JSON.stringify(i.result).slice(0, 1500)}` : ''
      const err = i.error ? `\nerror: ${JSON.stringify(i.error).slice(0, 500)}` : ''
      return truncate(`${head}\nargs: ${truncate(args, 1000)}${result}${err}`)
    }

    case 'dynamicToolCall': {
      const i = item as any
      const head = `🛠 ${i.tool} (${i.status ?? '?'})${i.success === false ? ' ❌' : ''}`
      const args = JSON.stringify(i.arguments ?? {}, null, 2)
      const out = (i.contentItems ?? [])
        .map((c: any) =>
          typeof c?.text === 'string' ? c.text : JSON.stringify(c).slice(0, 500),
        )
        .join('\n')
      return truncate(`${head}\nargs: ${truncate(args, 800)}${out ? `\n${out}` : ''}`)
    }

    case 'webSearch': {
      const i = item as any
      const q = i.query ?? '?'
      return truncate(`🌐 web search: "${q}"`)
    }

    case 'imageView':
    case 'imageGeneration': {
      const i = item as any
      const path = i.savedPath ?? i.path ?? '?'
      return truncate(`🖼 ${item.type}: ${path}${i.revisedPrompt ? `\n${i.revisedPrompt}` : ''}`)
    }

    case 'contextCompaction':
      return '🗜 context compacted (older messages summarized)'

    case 'enteredReviewMode':
      return `👁 entered review mode: ${(item as any).review ?? ''}`

    case 'exitedReviewMode':
      return `👁 exited review mode`

    default: {
      // Audit rule #4: never silently drop. Render unknown items so the
      // user knows codex did something — and so we get a signal to add
      // explicit rendering later.
      const j = JSON.stringify(item).slice(0, 1500)
      return truncate(`(item type=${item.type})\n${j}`)
    }
  }
}
