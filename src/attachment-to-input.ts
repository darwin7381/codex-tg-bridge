/**
 * Translate TG `Attachment`s into agent-protocol input blocks.
 *
 * Codex (app-server JSON-RPC) accepts the `UserInput` union:
 *   {type:"text", text, text_elements} | {type:"localImage", path} |
 *   {type:"image", url} | {type:"skill", ...} | {type:"mention", ...}
 *
 * Gemini (ACP) accepts the MCP `ContentBlock` union:
 *   {type:"text", text} | {type:"image", data:<base64>, mimeType} |
 *   {type:"audio", data:<base64>, mimeType} |
 *   {type:"resource_link", uri, name, mimeType?, size?} |
 *   {type:"resource", resource: {uri, text|blob, mimeType?}}
 *
 * Mapping per attachment kind (best-effort fidelity):
 *
 *   image      → codex: localImage{path};                gemini: image{base64+mime}
 *   voice      → codex: text mention (audio not natively accepted);
 *                gemini: audio{base64+mime}
 *   audio      → codex: text mention; gemini: audio{base64+mime}
 *   document   → text-MIME: inline `text` block both sides;
 *                other:    codex text mention; gemini resource_link
 *   video      → both sides: text mention with path (full video as
 *                content block isn't reliably supported)
 *   animation  → same as video
 *   sticker    → never an Attachment (rendered as text upstream)
 */

import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import type { Attachment } from './telegram-client.ts'

// --- types ---------------------------------------------------------------

export type CodexInputBlock =
  | { type: 'text'; text: string; text_elements: [] }
  | { type: 'localImage'; path: string }

export type AcpContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'audio'; data: string; mimeType: string }
  | { type: 'resource_link'; uri: string; name: string; mimeType?: string; size?: number }

const TEXT_MIME_PREFIXES = ['text/', 'application/json', 'application/xml', 'application/x-yaml']
const TEXT_MIME_INLINE_MAX = 32 * 1024 // 32 KB before we degrade to a mention

function isTextMime(mime?: string): boolean {
  if (!mime) return false
  const m = mime.toLowerCase()
  return TEXT_MIME_PREFIXES.some(prefix => m.startsWith(prefix))
}

async function tryReadTextInline(a: Attachment): Promise<string | null> {
  if (!isTextMime(a.mime)) return null
  try {
    const s = await stat(a.path)
    if (s.size > TEXT_MIME_INLINE_MAX) return null
    return await readFile(a.path, 'utf8')
  } catch {
    return null
  }
}

async function fileToBase64(path: string): Promise<string> {
  const buf = await readFile(path)
  return buf.toString('base64')
}

// --- codex ---------------------------------------------------------------

/**
 * Convert text + attachments into codex's UserInput[]. Attachments codex
 * can't ingest natively (audio, video) are rendered as text mentions so
 * the agent can `Bash`/`Read` them itself.
 */
export async function attachmentsToCodexInput(
  text: string,
  attachments: ReadonlyArray<Attachment>,
): Promise<CodexInputBlock[]> {
  const blocks: CodexInputBlock[] = []
  const mentions: string[] = []

  for (const a of attachments) {
    if (a.kind === 'image') {
      blocks.push({ type: 'localImage', path: a.path })
      continue
    }
    if (a.kind === 'document') {
      const inline = await tryReadTextInline(a)
      if (inline !== null) {
        const fname = a.name ?? basename(a.path)
        mentions.push(
          `User attached document "${fname}" (${a.mime ?? 'text'}, ${a.size}B):\n\`\`\`\n${inline.slice(0, 32 * 1024)}\n\`\`\``,
        )
      } else {
        mentions.push(
          `User attached document "${a.name ?? basename(a.path)}" (${a.mime ?? 'binary'}, ${a.size}B) at \`${a.path}\` — use Read/Bash to inspect.`,
        )
      }
      continue
    }
    if (a.kind === 'voice' || a.kind === 'audio') {
      const dur = a.duration != null ? `, ${a.duration}s` : ''
      mentions.push(
        `User attached audio "${a.name ?? basename(a.path)}" (${a.mime ?? 'audio'}, ${a.size}B${dur}) at \`${a.path}\`. ` +
          `Codex cannot natively ingest audio — Bash transcribe it (e.g. \`whisper "${a.path}"\` or \`gemini -p "transcribe ${a.path}"\`) if you need the content.`,
      )
      continue
    }
    if (a.kind === 'video' || a.kind === 'animation') {
      const dur = a.duration != null ? `, ${a.duration}s` : ''
      mentions.push(
        `User attached ${a.kind} "${a.name ?? basename(a.path)}" (${a.mime ?? 'video'}, ${a.size}B${dur}) at \`${a.path}\`. ` +
          `Extract a frame with ffmpeg if you need the visuals, or split the audio for transcription.`,
      )
      continue
    }
  }

  const combinedText = [text, ...mentions].filter(Boolean).join('\n\n')
  if (combinedText) {
    // Prepend a single text block carrying the user's prose plus any
    // mention lines. Image localImage blocks ride alongside.
    blocks.unshift({ type: 'text', text: combinedText, text_elements: [] })
  }
  return blocks
}

// --- gemini ACP ----------------------------------------------------------

/**
 * Convert text + attachments into ACP ContentBlock[]. Gemini natively
 * accepts text / image / audio per its `promptCapabilities.image` +
 * `.audio` flags. Documents go inline (text MIME) or as resource_link
 * so the agent can fetch them via its own tools. Videos / animations
 * are downgraded to resource_link.
 */
export async function attachmentsToAcpContent(
  text: string,
  attachments: ReadonlyArray<Attachment>,
): Promise<AcpContentBlock[]> {
  const blocks: AcpContentBlock[] = []

  if (text) blocks.push({ type: 'text', text })

  for (const a of attachments) {
    if (a.kind === 'image') {
      try {
        const data = await fileToBase64(a.path)
        blocks.push({ type: 'image', data, mimeType: a.mime ?? 'image/jpeg' })
      } catch (err) {
        blocks.push({
          type: 'text',
          text: `(image attachment at ${a.path} could not be read: ${(err as Error).message})`,
        })
      }
      continue
    }
    if (a.kind === 'voice' || a.kind === 'audio') {
      try {
        const data = await fileToBase64(a.path)
        blocks.push({ type: 'audio', data, mimeType: a.mime ?? 'audio/ogg' })
      } catch (err) {
        blocks.push({
          type: 'text',
          text: `(audio attachment at ${a.path} could not be read: ${(err as Error).message})`,
        })
      }
      continue
    }
    if (a.kind === 'document') {
      const inline = await tryReadTextInline(a)
      if (inline !== null) {
        blocks.push({
          type: 'text',
          text: `Attached document "${a.name ?? basename(a.path)}" (${a.mime ?? 'text'}):\n${inline.slice(0, 32 * 1024)}`,
        })
      } else {
        blocks.push({
          type: 'resource_link',
          uri: `file://${a.path}`,
          name: a.name ?? basename(a.path),
          mimeType: a.mime,
          size: a.size,
        })
      }
      continue
    }
    if (a.kind === 'video' || a.kind === 'animation') {
      blocks.push({
        type: 'resource_link',
        uri: `file://${a.path}`,
        name: a.name ?? basename(a.path),
        mimeType: a.mime ?? 'video/mp4',
        size: a.size,
      })
      continue
    }
  }

  return blocks
}
