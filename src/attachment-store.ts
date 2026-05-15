/**
 * Attachment downloader + on-disk store for inbound TG media.
 *
 * Files arrive on Telegram as `file_id` references. We resolve them via
 * `getFile`, fetch the bytes over HTTPS, persist under `$STATE_DIR/inbox/`,
 * and hand absolute paths to the agent layer.
 *
 * Layout:
 *   $STATE_DIR/inbox/<msgId>-<timestamp>-<sanitized-name>
 *
 * Garbage collection runs hourly in-process: files older than
 * `MAX_AGE_MS` (default 7 days) get deleted; if total size > `MAX_BYTES`
 * (default 1 GiB) the oldest get deleted until under the cap.
 */

import { existsSync, readdirSync, statSync, unlinkSync, mkdirSync, createWriteStream } from 'node:fs'
import { join, basename, extname } from 'node:path'
import { pipeline } from 'node:stream/promises'

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const MAX_BYTES = 1024 * 1024 * 1024 // 1 GiB
const PER_FILE_MAX_BYTES = 50 * 1024 * 1024 // Telegram's hard cap for bots
const GC_INTERVAL_MS = 60 * 60 * 1000 // 1 hour

/** Strip path separators + control chars + collapse whitespace. */
function sanitizeName(name: string | undefined, fallbackExt = ''): string {
  if (!name) return `file${fallbackExt}`
  return (
    name
      .replace(/[\x00-\x1f\\/]/g, '_')
      .replace(/\s+/g, '_')
      .slice(-120) || `file${fallbackExt}`
  )
}

export class AttachmentStore {
  private readonly inboxDir: string
  private gcTimer: ReturnType<typeof setInterval> | null = null

  constructor(stateDir: string) {
    this.inboxDir = join(stateDir, 'inbox')
    mkdirSync(this.inboxDir, { recursive: true })
  }

  /** Start the hourly garbage-collection timer. Idempotent. */
  startGC(log?: (level: 'info' | 'warn', msg: string) => void): void {
    if (this.gcTimer) return
    const tick = (): void => {
      try {
        const removed = this.gcOnce()
        if (removed.count > 0)
          log?.('info', `attachment GC: removed ${removed.count} files (${removed.bytes} bytes)`)
      } catch (err) {
        log?.('warn', `attachment GC failed: ${(err as Error).message}`)
      }
    }
    this.gcTimer = setInterval(tick, GC_INTERVAL_MS)
    // Run one tick on startup too.
    queueMicrotask(tick)
  }

  stopGC(): void {
    if (this.gcTimer) clearInterval(this.gcTimer)
    this.gcTimer = null
  }

  /**
   * Download a TG file by `file_id` to inboxDir. Returns the absolute
   * path on disk (or throws on size cap / network failure).
   */
  async fetchTelegramFile(args: {
    token: string
    fileId: string
    messageId: number
    suggestedName?: string
    mime?: string
  }): Promise<{ path: string; bytes: number }> {
    const { token, fileId, messageId, suggestedName, mime } = args

    // 1. Resolve file_id → file_path + size.
    const metaResp = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`)
    if (!metaResp.ok) throw new Error(`getFile ${fileId}: HTTP ${metaResp.status}`)
    const metaJson = (await metaResp.json()) as {
      ok: boolean
      result?: { file_path: string; file_size?: number }
      description?: string
    }
    if (!metaJson.ok || !metaJson.result?.file_path) {
      throw new Error(`getFile ${fileId}: ${metaJson.description ?? 'no file_path'}`)
    }
    const fileSize = metaJson.result.file_size ?? 0
    if (fileSize > PER_FILE_MAX_BYTES) {
      throw new Error(`file too large: ${fileSize} bytes > ${PER_FILE_MAX_BYTES}`)
    }

    // 2. Build local filename + path.
    const tgPath = metaJson.result.file_path
    const tgExt = extname(tgPath) || (mime ? mimeToExt(mime) : '')
    const safeName = sanitizeName(suggestedName ?? basename(tgPath), tgExt)
    const local = join(
      this.inboxDir,
      `${messageId}-${Date.now()}-${safeName}${safeName.endsWith(tgExt) ? '' : tgExt}`,
    )

    // 3. Stream download.
    const fileUrl = `https://api.telegram.org/file/bot${token}/${tgPath}`
    const fileResp = await fetch(fileUrl)
    if (!fileResp.ok) throw new Error(`download ${tgPath}: HTTP ${fileResp.status}`)
    if (!fileResp.body) throw new Error(`download ${tgPath}: empty body`)
    const out = createWriteStream(local)
    // node's pipeline accepts both web streams (fetch) and node streams.
    await pipeline(fileResp.body as unknown as NodeJS.ReadableStream, out)

    const finalSize = statSync(local).size
    return { path: local, bytes: finalSize }
  }

  /** Sync GC pass. Public so tests can call deterministically. */
  gcOnce(): { count: number; bytes: number } {
    if (!existsSync(this.inboxDir)) return { count: 0, bytes: 0 }
    type Entry = { path: string; mtimeMs: number; size: number }
    const entries: Entry[] = []
    for (const name of readdirSync(this.inboxDir)) {
      const p = join(this.inboxDir, name)
      try {
        const s = statSync(p)
        if (s.isFile()) entries.push({ path: p, mtimeMs: s.mtimeMs, size: s.size })
      } catch {
        // disappeared mid-scan
      }
    }

    const now = Date.now()
    let removedCount = 0
    let removedBytes = 0

    // Pass 1: age out files past MAX_AGE_MS.
    for (const e of entries) {
      if (now - e.mtimeMs > MAX_AGE_MS) {
        try {
          unlinkSync(e.path)
          removedCount++
          removedBytes += e.size
          e.size = -1 // marker: gone
        } catch {
          // already removed?
        }
      }
    }

    // Pass 2: enforce total-size cap (delete oldest first).
    let total = entries.reduce((sum, e) => (e.size > 0 ? sum + e.size : sum), 0)
    if (total > MAX_BYTES) {
      const live = entries.filter(e => e.size > 0).sort((a, b) => a.mtimeMs - b.mtimeMs)
      for (const e of live) {
        if (total <= MAX_BYTES) break
        try {
          unlinkSync(e.path)
          total -= e.size
          removedCount++
          removedBytes += e.size
        } catch {
          // gone already
        }
      }
    }

    return { count: removedCount, bytes: removedBytes }
  }
}

function mimeToExt(mime: string): string {
  const map: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/heic': '.heic',
    'audio/ogg': '.ogg',
    'audio/mpeg': '.mp3',
    'audio/mp4': '.m4a',
    'audio/wav': '.wav',
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
    'application/pdf': '.pdf',
    'application/zip': '.zip',
    'text/plain': '.txt',
    'text/markdown': '.md',
    'application/json': '.json',
  }
  return map[mime.toLowerCase()] ?? ''
}
