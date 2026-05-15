/**
 * Tracks codex approval requests that are waiting for a Telegram-side
 * decision. Each request gets a short `cbId` we embed in inline-keyboard
 * callback_data; when the user clicks a button, we resolve the
 * corresponding JSON-RPC `reply` callback with their decision.
 *
 * No timeout enforced here — codex's app-server already has its own
 * approval timeout (defined per-policy). Add explicit timeout / TG
 * notification if codex starts cancelling requests before users respond.
 */

import { randomBytes } from 'node:crypto'

export type ApprovalType = 'commandExecution' | 'fileChange' | 'permissions'

/**
 * Allowed decision tokens differ per request type, but Telegram callback
 * data is a free-form string. We re-validate in resolve().
 *
 * CommandExecutionApprovalDecision = "accept" | "acceptForSession" |
 *                                    "decline" | "cancel" | ...
 * FileChangeApprovalDecision         = "accept" | "decline" | ...
 * PermissionsRequestApprovalResponse = "accept" | "decline" | ...
 */
const VALID_DECISIONS: Record<ApprovalType, ReadonlyArray<string>> = {
  commandExecution: ['accept', 'acceptForSession', 'decline', 'cancel'],
  fileChange: ['accept', 'decline'],
  permissions: ['accept', 'decline'],
}

export type PendingApproval = {
  cbId: string
  type: ApprovalType
  threadId: string
  itemId: string
  reply: (result: unknown) => void
  registeredAt: number
}

export class ApprovalTracker {
  private pending = new Map<string, PendingApproval>()

  register(
    type: ApprovalType,
    params: { threadId: string; itemId: string },
    reply: (result: unknown) => void,
  ): string {
    const cbId = randomBytes(4).toString('hex') // 8 hex chars; well under TG 64-byte callback_data limit
    this.pending.set(cbId, {
      cbId,
      type,
      threadId: params.threadId,
      itemId: params.itemId,
      reply,
      registeredAt: Date.now(),
    })
    return cbId
  }

  /** Returns true if the cbId was found and resolved. */
  resolve(cbId: string, decision: string): { ok: true; type: ApprovalType } | { ok: false; reason: string } {
    const entry = this.pending.get(cbId)
    if (!entry) return { ok: false, reason: 'unknown cbId (already resolved or expired)' }
    if (!VALID_DECISIONS[entry.type].includes(decision)) {
      return { ok: false, reason: `invalid decision "${decision}" for type ${entry.type}` }
    }
    entry.reply({ decision })
    this.pending.delete(cbId)
    return { ok: true, type: entry.type }
  }

  size(): number {
    return this.pending.size
  }
}
