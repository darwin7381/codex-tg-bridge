/**
 * Persistent chat_id → thread_id mapping. Stored as flat JSON in the state
 * dir so the bridge can pick up where it left off after a restart.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

type Mapping = Record<string, string>

export class SessionMap {
  private map: Mapping = {}
  private writeQueued = false

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.path, 'utf8')
      this.map = JSON.parse(raw)
    } catch {
      this.map = {}
    }
  }

  get(chatId: string): string | undefined {
    return this.map[chatId]
  }

  async set(chatId: string, threadId: string): Promise<void> {
    this.map[chatId] = threadId
    await this.flush()
  }

  async clear(chatId: string): Promise<void> {
    delete this.map[chatId]
    await this.flush()
  }

  private async flush(): Promise<void> {
    if (this.writeQueued) return
    this.writeQueued = true
    queueMicrotask(async () => {
      this.writeQueued = false
      try {
        await mkdir(dirname(this.path), { recursive: true })
        await writeFile(this.path, JSON.stringify(this.map, null, 2))
      } catch (err) {
        console.error(`[session-map] flush failed: ${err}`)
      }
    })
  }
}
