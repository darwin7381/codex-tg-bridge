/**
 * Render ACP `session/update` payloads into Telegram-friendly text.
 *
 * Parallel to `item-formatter.ts` (which targets codex's ThreadItem
 * union). ACP encodes everything under `update.sessionUpdate` —
 * different shapes per update type. Reference:
 * https://agentclientprotocol.com/protocol/tool-calls
 *
 * Audit rule #4: never silently drop. Unknown `sessionUpdate` types
 * fall through to a generic dump so the user always sees activity.
 */

const MAX_OUTPUT = 3500

function truncate(s: string, n = MAX_OUTPUT): string {
  if (s.length <= n) return s
  return s.slice(0, n - 20) + `\n…(+${s.length - n} chars)`
}

export type AcpUpdate = {
  sessionUpdate?: string
  [k: string]: unknown
}

export function formatAcpUpdate(update: AcpUpdate): string | null {
  const kind = update.sessionUpdate

  switch (kind) {
    case 'agent_message_chunk':
      // Streaming text handled by TurnStreamConsumer; suppress here.
      return null

    case 'agent_thought_chunk':
      // Quiet to avoid pane spam; agents stream these constantly.
      return null

    case 'plan': {
      const entries = (update as any).entries as Array<{ content: string; status?: string }> | undefined
      if (!Array.isArray(entries) || entries.length === 0) return null
      const lines = entries
        .slice(0, 12)
        .map(e => `  ${e.status === 'completed' ? '✔' : e.status === 'in_progress' ? '►' : '·'} ${e.content}`)
      return truncate(`📋 plan:\n${lines.join('\n')}`)
    }

    case 'tool_call': {
      const u = update as any
      const kindLabel = u.kind ?? 'tool'
      const title = u.title ?? '?'
      const status = u.status ?? 'pending'
      const emoji =
        kindLabel === 'execute' ? '⌨️' :
        kindLabel === 'edit' ? '📝' :
        kindLabel === 'delete' ? '🗑' :
        kindLabel === 'read' ? '👀' :
        kindLabel === 'search' ? '🔍' :
        kindLabel === 'fetch' ? '🌐' :
        kindLabel === 'think' ? '🤔' :
        '🛠'
      return truncate(`${emoji} ${kindLabel}: ${title}\nstatus: ${status}`)
    }

    case 'tool_call_update': {
      // Only surface terminal states (completed / failed); skip
      // in_progress to avoid noise.
      const u = update as any
      const status = u.status
      if (status !== 'completed' && status !== 'failed') return null
      const id = u.toolCallId?.slice(0, 8) ?? '?'
      const emoji = status === 'completed' ? '✔' : '❌'
      let body = `${emoji} tool ${id} ${status}`
      if (Array.isArray(u.content) && u.content.length > 0) {
        const text = u.content
          .map((c: any) => (typeof c?.content?.text === 'string' ? c.content.text : (typeof c?.text === 'string' ? c.text : '')))
          .filter(Boolean)
          .join('\n')
        if (text) body += `\n${truncate(text, 2500)}`
      }
      return truncate(body)
    }

    case 'available_commands_update':
      // Codex equivalent is silent. Gemini emits at session startup
      // and after MCP changes; skip.
      return null

    case 'current_mode_update':
    case 'context_compaction':
    case 'session_metadata':
      return null

    default: {
      // Audit rule #4: unknown — render a generic dump.
      const j = JSON.stringify(update).slice(0, 1500)
      return truncate(`(session/update kind=${kind ?? 'unknown'})\n${j}`)
    }
  }
}
