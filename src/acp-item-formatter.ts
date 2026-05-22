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
 *
 * Defensive sanitizer: agent_message_chunk and other free-form text
 * sometimes carries terminal control sequences (ANSI escapes,
 * box-drawing characters used for tables, NUL bytes from buffer
 * mishandling). These render as garbage in Telegram. `sanitizeForTg`
 * strips the ones we know don't render.
 */

const MAX_OUTPUT = 3500

function truncate(s: string, n = MAX_OUTPUT): string {
  if (s.length <= n) return s
  return s.slice(0, n - 20) + `\n…(+${s.length - n} chars)`
}

/**
 * Strip terminal control sequences + null bytes + box-drawing
 * characters that don't render meaningfully in Telegram. Idempotent.
 */
export function sanitizeForTg(s: string): string {
  if (!s) return s
  return (
    s
      // CSI ANSI sequences: ESC [ ... letter
      .replace(/\x1b\[[0-9;?]*[ -\/]*[a-zA-Z]/g, '')
      // OSC sequences: ESC ] ... BEL/ST
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
      // Other ESC + single-char sequences
      .replace(/\x1b[@-_]/g, '')
      // Null bytes
      .replace(/\x00/g, '')
      // Box drawing characters → ASCII equivalents
      .replace(/[─-╿]/g, c => {
        const m: Record<string, string> = {
          '─': '-', '━': '-', '│': '|', '┃': '|',
          '┌': '+', '┐': '+', '└': '+', '┘': '+',
          '├': '+', '┤': '+', '┬': '+', '┴': '+', '┼': '+',
        }
        return m[c] ?? ' '
      })
      // Other lone control chars except \n \r \t
      .replace(/[\x01-\x08\x0b\x0c\x0e-\x1f]/g, '')
  )
}

/** Tool-name → emoji map for gemini's well-known tools. */
function toolEmoji(name: string | undefined, fallback: string): string {
  const n = (name ?? '').toLowerCase()
  if (n.includes('enter_plan_mode') || n.includes('plan_mode')) return '🎯'
  if (n.includes('exit_plan_mode')) return '✅'
  if (n.includes('google_web_search') || n.includes('web_search')) return '🌐'
  if (n.includes('codebase_investigator')) return '🕵️'
  if (n.includes('activate_skill')) return '⚡'
  if (n.includes('save_memory') || n.includes('memory')) return '🧠'
  if (n.includes('write_todos') || n.includes('todo')) return '📋'
  if (n.includes('generalist')) return '🤖'
  if (n.includes('ask_user') || n.includes('ask user')) return '❓'
  return fallback
}

export type AcpUpdate = {
  sessionUpdate?: string
  [k: string]: unknown
}

/**
 * Render a write_todos tool call (gemini's todo tracker) as a
 * checkbox list.
 */
function renderWriteTodos(update: any): string | null {
  const args =
    update?.rawInput ??
    update?.input ??
    (update?.content && update.content[0]?.input) ??
    null
  const todos: Array<{ content?: string; status?: string }> | undefined = args?.todos
  if (!Array.isArray(todos) || todos.length === 0) return null
  const lines = todos.slice(0, 30).map(t => {
    const status = (t.status ?? 'pending').toLowerCase()
    const box =
      status === 'completed' || status === 'done'
        ? '☑️'
        : status === 'in_progress' || status === 'doing' || status === 'active'
          ? '▶️'
          : '🔲'
    const text = t.content ?? '(?)'
    return `${box} ${text}`
  })
  return truncate(`📋 todos:\n${lines.join('\n')}`)
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

    case 'user_message_chunk': {
      // Emitted during sessionLoad replay (gemini re-streams the
      // conversation history). Each historical user-side message arrives
      // as one chunk. Render compactly so the user can see their past
      // messages without the raw-JSON dump that the default case would
      // produce. The default case fell through to a JSON dump because
      // this kind wasn't handled — that produced the ugly
      // `(session/update kind=user_message_chunk) {...}` lines that
      // Joey called out 2026-05-22.
      const content = (update as any).content
      const text =
        content && typeof content === 'object' && typeof content.text === 'string'
          ? content.text
          : typeof content === 'string'
            ? content
            : ''
      if (!text) return null
      return truncate(`👤 ${sanitizeForTg(text).replace(/\n/g, ' ')}`, 800)
    }

    case 'plan': {
      const entries = (update as any).entries as Array<{ content: string; status?: string }> | undefined
      if (!Array.isArray(entries) || entries.length === 0) return null
      const lines = entries
        .slice(0, 12)
        .map(e => `  ${e.status === 'completed' ? '✔' : e.status === 'in_progress' ? '►' : '·'} ${sanitizeForTg(e.content)}`)
      return truncate(`📋 plan:\n${lines.join('\n')}`)
    }

    case 'tool_call': {
      const u = update as any
      // Special-case write_todos so we render a checkbox list rather
      // than a generic "tool: write_todos" line.
      if (
        (u.title && /todo/i.test(u.title)) ||
        (u.rawInput && Array.isArray(u.rawInput.todos))
      ) {
        const rendered = renderWriteTodos(u)
        if (rendered) return rendered
      }
      const kindLabel = u.kind ?? 'tool'
      const emoji = toolEmoji(u.title, baseToolEmoji(kindLabel))
      const title = sanitizeForTg(u.title ?? '?')
      const status = u.status ?? 'pending'
      // Include a short content preview if the tool surfaced any —
      // diff/text/exec snippets help the user judge what's going on.
      const contentPreview = renderToolContent(u.content)
      return truncate(
        `${emoji} ${kindLabel}: ${title}\nstatus: ${status}${contentPreview ? `\n${contentPreview}` : ''}`,
      )
    }

    case 'tool_call_update': {
      // Surface tool completion ONLY when it carries useful new info
      // (output content or a failure). A bare "completed" line for the
      // already-shown tool_call adds no signal — it just doubles the
      // message count. (Joey 2026-05-22: the screen filled with
      // identical "✔ tool run_shel completed" — that's the toolCallId
      // prefix sliced to 8 chars, not the tool name; meaningless.)
      const u = update as any
      const status = u.status
      // Errors / failures: always show — user needs to know the tool died.
      if (status === 'failed') {
        const preview = renderToolContent(u.content)
        const title = u.title ? sanitizeForTg(u.title) : `id=${u.toolCallId?.slice(0, 8) ?? '?'}`
        return truncate(`❌ failed: ${title}${preview ? `\n${preview}` : ''}`)
      }
      // Successes: surface ONLY if there's actual content to show
      // (command output, file diff, etc). Bare completion = drop it.
      if (status === 'completed') {
        const preview = renderToolContent(u.content)
        if (!preview) return null  // no new info → suppress (was the spam source)
        const title = u.title ? sanitizeForTg(u.title) : `id=${u.toolCallId?.slice(0, 8) ?? '?'}`
        return truncate(`✔ ${title}\n${preview}`)
      }
      // in_progress and others — skip.
      return null
    }

    case 'available_commands_update':
    case 'current_mode_update':
    case 'context_compaction':
    case 'session_metadata':
      return null

    default: {
      // Audit rule #4: unknown — render a generic sanitized dump.
      const j = sanitizeForTg(JSON.stringify(update).slice(0, 1500))
      return truncate(`(session/update kind=${kind ?? 'unknown'})\n${j}`)
    }
  }
}

function baseToolEmoji(kindLabel: string): string {
  switch (kindLabel) {
    case 'execute':
      return '⌨️'
    case 'edit':
      return '📝'
    case 'delete':
      return '🗑'
    case 'read':
      return '👀'
    case 'search':
      return '🔍'
    case 'fetch':
      return '🌐'
    case 'think':
      return '🤔'
    default:
      return '🛠'
  }
}

/**
 * ACP `tool_call.content` is `ContentBlock[]`. Common variants we
 * surface here:
 *   { type: 'text', text }        — output text
 *   { type: 'diff', path, oldText, newText }  — file edit
 *   { type: 'image', ... }        — agent-produced image (handled
 *     elsewhere for outbound media)
 *   shell exec output may also arrive embedded in text
 */
function renderToolContent(content: unknown): string | null {
  if (!Array.isArray(content) || content.length === 0) return null
  const parts: string[] = []
  for (const c of content.slice(0, 4)) {
    const t = (c as any)?.type
    if (t === 'text') {
      const text = sanitizeForTg(String((c as any).text ?? '')).slice(0, 800)
      if (text) parts.push(text)
    } else if (t === 'diff') {
      const path = (c as any).path ?? '?'
      const oldText = String((c as any).oldText ?? '').slice(0, 400)
      const newText = String((c as any).newText ?? '').slice(0, 400)
      const lines = [`diff: ${path}`]
      if (oldText) lines.push('--- old', sanitizeForTg(oldText))
      if (newText) lines.push('+++ new', sanitizeForTg(newText))
      parts.push(lines.join('\n'))
    } else if (t === 'resource' && (c as any).resource?.text) {
      const text = sanitizeForTg(String((c as any).resource.text)).slice(0, 800)
      if (text) parts.push(text)
    } else if (t === 'resource_link' && (c as any).uri) {
      parts.push(`→ ${(c as any).uri}`)
    }
  }
  return parts.length > 0 ? parts.join('\n').slice(0, 2500) : null
}

/**
 * Best-effort extraction of file paths the agent just produced
 * (image / pdf / archive / audio / video). Used by the gemini server
 * to auto-forward media to Telegram instead of leaving the user with
 * a path-string mention.
 */
export function extractGeneratedPaths(update: AcpUpdate): string[] {
  const u = update as any
  const out: string[] = []
  const considerPath = (s: unknown): void => {
    if (typeof s !== 'string') return
    if (!s.startsWith('/')) return
    out.push(s)
  }
  // tool_call rawInput / arguments / content blocks
  considerPath(u?.rawInput?.file_path)
  considerPath(u?.rawInput?.path)
  if (Array.isArray(u?.locations))
    for (const loc of u.locations) considerPath(loc?.path)
  if (Array.isArray(u?.content)) {
    for (const c of u.content) {
      considerPath(c?.path)
      considerPath(c?.uri)
      if (c?.resource_link?.uri) considerPath(c.resource_link.uri)
    }
  }
  return out
    .filter(p => /\.(png|jpg|jpeg|gif|webp|heic|pdf|zip|tar|gz|mp4|mov|wav|mp3|m4a)$/i.test(p))
}
