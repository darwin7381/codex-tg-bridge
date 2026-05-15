/**
 * Per-item streaming consumer for agentMessage deltas.
 *
 * Ported from Hermes `gateway/stream_consumer.py` (1018 lines, production
 * battle-tested). Same invariants:
 *
 *   1. ONE consumer per agentMessage item. The consumer owns one Telegram
 *      message that it sends fresh on the first flush and edits in place
 *      on subsequent flushes.
 *   2. Edit triggers (in priority order):
 *        a. finish() was called (stream done)
 *        b. ≥ EDIT_INTERVAL_S since last edit AND new content
 *        c. accumulated unsent bytes ≥ BUFFER_THRESHOLD
 *   3. Adaptive backoff on 429 / flood-control:
 *        flood_strikes++
 *        current_interval_s = min(current * 2, 10)
 *        after MAX_FLOOD_STRIKES → fallback (skip edits, deliver final
 *        text on finish() via a fresh reply)
 *   4. Single-task drain → producers (delta callbacks) only ENQUEUE; the
 *      run() task is the only thing that calls Telegram. This eliminates
 *      the race-condition family of bugs.
 *   5. Cursor (" ▉") appended while streaming; stripped on finalize.
 */

import type { TelegramClient } from './telegram-client.ts'

type LogFn = (level: 'info' | 'warn' | 'error', msg: string) => void

const EDIT_INTERVAL_S = 1.0
const BUFFER_THRESHOLD = 40
const MAX_FLOOD_STRIKES = 3
const MAX_TG_TEXT = 4000
const CURSOR = ' ▉'
const TICK_MS = 100

function isFloodError(err: unknown): boolean {
  const msg = ((err as { message?: string })?.message ?? '').toLowerCase()
  return (
    msg.includes('flood') ||
    msg.includes('retry after') ||
    msg.includes('too many requests') ||
    msg.includes('429')
  )
}

type Wake = { promise: Promise<void>; resolve: () => void }
function makeWake(): Wake {
  let resolve!: () => void
  const promise = new Promise<void>(r => {
    resolve = r
  })
  return { promise, resolve }
}

export class TurnStreamConsumer {
  private buffer = ''
  private lastSent = ''
  private lastEditAtMs = 0
  private messageId = -1
  private currentIntervalS = EDIT_INTERVAL_S
  private floodStrikes = 0
  private fallbackMode = false
  private done = false
  private wake: Wake = makeWake()

  constructor(
    private readonly tg: TelegramClient,
    private readonly chatId: string,
    private readonly log: LogFn,
  ) {}

  /** Producer side — non-blocking, single line. */
  enqueueDelta(delta: string): void {
    if (!delta) return
    this.buffer += delta
    const w = this.wake
    this.wake = makeWake()
    w.resolve()
  }

  /** Producer side — call when codex emits item/completed for this item. */
  finish(canonicalText?: string): void {
    // If codex gave us a canonical final string (from item/completed.text),
    // prefer it over the accumulated deltas. Defensive: codex may polish
    // the final text differently than the sum of deltas (rare but
    // possible).
    if (canonicalText && canonicalText !== this.buffer) {
      this.buffer = canonicalText
    }
    this.done = true
    this.wake.resolve()
  }

  /** Consumer side — runs as a background task for this item's lifetime. */
  async run(): Promise<void> {
    // First flush is immediate (so the user sees activity right away
    // rather than waiting EDIT_INTERVAL_S for the first paint).
    let firstFlushDone = false

    while (true) {
      const nowMs = Date.now()
      const elapsedS = (nowMs - this.lastEditAtMs) / 1000
      const newBytes = this.buffer.length - this.lastSent.length
      const hasNewContent = newBytes > 0

      const shouldEdit =
        this.done ||
        (hasNewContent &&
          (!firstFlushDone ||
            elapsedS >= this.currentIntervalS ||
            newBytes >= BUFFER_THRESHOLD))

      if (shouldEdit && hasNewContent && !this.fallbackMode) {
        await this.flush()
        firstFlushDone = true
        this.lastEditAtMs = Date.now()
      }

      if (this.done) {
        // If fallback engaged and we never sent anything, deliver the
        // final text now (one fresh reply, no edits).
        if (this.fallbackMode && this.messageId === -1 && this.buffer) {
          try {
            await this.tg.reply(this.chatId, this.buffer.slice(0, MAX_TG_TEXT))
          } catch (err) {
            this.log('warn', `fallback final reply failed: ${(err as Error).message}`)
          }
        }
        return
      }

      // Wait for either the next delta (wake) or the tick interval.
      await Promise.race([
        this.wake.promise,
        new Promise<void>(r => setTimeout(r, TICK_MS)),
      ])
    }
  }

  /** Single-flight Telegram send/edit. Only called from run(). */
  private async flush(): Promise<void> {
    const baseText = this.buffer.slice(0, MAX_TG_TEXT)
    // Show cursor only mid-stream — strip it on the final edit.
    const displayText = this.done ? baseText : (baseText + CURSOR).slice(0, MAX_TG_TEXT)

    try {
      if (this.messageId === -1) {
        this.messageId = await this.tg.reply(this.chatId, displayText)
      } else {
        await this.tg.editMessage(this.chatId, this.messageId, displayText)
      }
      // Track what landed on the wire (without cursor) so the next edit
      // delta calculation doesn't count the cursor as "new content".
      this.lastSent = this.buffer
      this.floodStrikes = 0
    } catch (err) {
      if (isFloodError(err)) {
        this.floodStrikes++
        this.currentIntervalS = Math.min(this.currentIntervalS * 2, 10)
        this.log(
          'warn',
          `flood strike ${this.floodStrikes}/${MAX_FLOOD_STRIKES} → backoff interval ${this.currentIntervalS}s`,
        )
        if (this.floodStrikes >= MAX_FLOOD_STRIKES) {
          this.fallbackMode = true
          this.log(
            'warn',
            'flood strikes exhausted; entering fallback (send final text on done, no more edits)',
          )
        }
      } else {
        this.log('warn', `flush failed: ${(err as Error).message}`)
      }
    }
  }
}
