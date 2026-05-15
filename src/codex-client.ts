/**
 * codex app-server JSON-RPC client over WebSocket.
 *
 * Zero-degradation audit invariants enforced in this file:
 *   #1 thread/start sends NO `baseInstructions` / `developerInstructions`
 *      / `personality` / `model` / `approvalPolicy` / `sandbox` overrides.
 *      → server uses ~/.codex/config.toml defaults verbatim.
 *   #2 turn/start sends ONLY `threadId` + `input` (raw user text).
 *      → no model/personality/effort overrides; server reads config each
 *      turn.
 *   #4 item/* and turn/* notifications are re-emitted to listeners as-is;
 *      no filtering, no transformation.
 *
 * (Audit rules #3 = "raw text passthrough" and #5 = "config.toml is the
 * single source of truth" are enforced by the bridge loop, not this client.)
 *
 * Protocol reference:
 *   https://github.com/openai/codex/tree/main/codex-rs/app-server-protocol/schema/typescript/v2
 */

import { WebSocket } from 'ws'
import { EventEmitter } from 'node:events'

// --- types ---------------------------------------------------------------

export type ClientInfo = { name: string; title?: string; version: string }

export type InitializeResponse = {
  userAgent: string
  codexHome: string
  platformFamily: string
  platformOs: string
}

export type Thread = {
  /** Schema-confirmed: thread identity comes back as `id`, not `threadId`. */
  id: string
  sessionId: string
  // plus other fields populated by server; we don't need to model them
  // exhaustively — kept as opaque object so future schema additions don't
  // break this file
  [k: string]: unknown
}

export type ThreadStartResponse = {
  thread: Thread
  model: string
  modelProvider: string
  cwd: string
  [k: string]: unknown
}

export type ThreadItem = {
  type: string
  id: string
  [k: string]: unknown
}

export type ItemNotification = {
  threadId: string
  turnId: string
  item: ThreadItem
  startedAtMs?: number
  completedAtMs?: number
}

export type AgentMessageDelta = {
  threadId: string
  turnId: string
  itemId: string
  delta: string
}

export type TurnInfo = {
  turnId: string
  status?: string
  [k: string]: unknown
}

export type TurnNotification = { threadId: string; turn: TurnInfo }

// --- JSON-RPC framing ----------------------------------------------------

type RpcRequest = {
  jsonrpc: '2.0'
  id: number
  method: string
  params?: unknown
}

type RpcSuccess = { jsonrpc: '2.0'; id: number; result: unknown }
type RpcError = {
  jsonrpc: '2.0'
  id: number
  error: { code: number; message: string; data?: unknown }
}
type RpcNotification = { jsonrpc: '2.0'; method: string; params?: unknown }

// codex app-server omits the `jsonrpc: "2.0"` field on responses and
// notifications, so we identify frames by shape rather than the version
// tag.
function isResponse(m: any): m is RpcSuccess | RpcError {
  return (
    m &&
    typeof m === 'object' &&
    typeof m.id === 'number' &&
    typeof m.method !== 'string' &&
    ('result' in m || 'error' in m)
  )
}

function isNotification(m: any): m is RpcNotification {
  return (
    m &&
    typeof m === 'object' &&
    typeof m.method === 'string' &&
    m.id === undefined
  )
}

// Server-to-client JSON-RPC request: has both `id` AND `method`. Codex
// uses these for approval prompts (commandExecution / fileChange /
// permissions) when `approvalPolicy != "never"`.
type ServerRequest = {
  jsonrpc?: '2.0'
  id: number
  method: string
  params?: unknown
}
function isServerRequest(m: any): m is ServerRequest {
  return (
    m &&
    typeof m === 'object' &&
    typeof m.id === 'number' &&
    typeof m.method === 'string'
  )
}

// --- client --------------------------------------------------------------

export class CodexClient extends EventEmitter {
  private ws: WebSocket | null = null
  private nextId = 1
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (err: Error) => void }
  >()
  private buffer = ''
  private connected = false

  constructor(private readonly url: string) {
    super()
  }

  async connect(): Promise<void> {
    if (this.ws) throw new Error('already connected')
    const ws = new WebSocket(this.url)
    this.ws = ws

    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => {
        this.connected = true
        resolve()
      })
      ws.once('error', err => reject(err))
    })

    ws.on('message', (data: Buffer | string) => this.onFrame(data.toString()))
    ws.on('close', () => {
      this.connected = false
      this.emit('close')
      // Reject all pending requests so the caller can decide what to do.
      const err = new Error('websocket closed')
      for (const { reject } of this.pending.values()) reject(err)
      this.pending.clear()
    })
    ws.on('error', err => this.emit('error', err))
  }

  close(): void {
    this.ws?.close()
  }

  isConnected(): boolean {
    return this.connected
  }

  /**
   * One JSON-RPC message per WebSocket text frame.
   * Reference: https://developers.openai.com/codex/app-server
   *
   * Three frame types are possible:
   *   - Response (id + result/error): reply to our own request
   *   - Notification (method, no id): server-pushed event
   *   - Server request (id + method): server wants us to decide
   *     something (e.g. approve a command). Must respond by `id`.
   */
  private onFrame(text: string): void {
    let msg: unknown
    try {
      msg = JSON.parse(text)
    } catch (err) {
      this.emit('error', new Error(`bad JSON from server: ${text.slice(0, 200)}`))
      return
    }
    if (isResponse(msg)) {
      const slot = this.pending.get(msg.id)
      if (!slot) {
        this.emit('error', new Error(`response for unknown id=${msg.id}`))
        return
      }
      this.pending.delete(msg.id)
      if ('error' in msg) {
        slot.reject(
          new Error(
            `${msg.error.code} ${msg.error.message}` +
              (msg.error.data ? ` — ${JSON.stringify(msg.error.data)}` : ''),
          ),
        )
      } else {
        slot.resolve(msg.result)
      }
      return
    }
    if (isServerRequest(msg)) {
      // Audit rule #4 (corollary): never silently drop server-to-client
      // requests. Re-emit for the server.ts orchestrator to handle, and
      // include a one-shot reply function so it can craft the right
      // response shape per method without us re-encoding here.
      this.emit('serverRequest', msg.method, msg.params, (result: unknown) =>
        this.sendResponse(msg.id, result),
      )
      this.emit(`request:${msg.method}`, msg.params, (result: unknown) =>
        this.sendResponse(msg.id, result),
      )
      return
    }
    if (isNotification(msg)) {
      // Audit rule #4: forward verbatim to listeners. No filtering.
      this.emit('notification', msg.method, msg.params)
      this.emit(`method:${msg.method}`, msg.params)
      return
    }
    this.emit('error', new Error(`unrecognized RPC frame: ${text.slice(0, 200)}`))
  }

  private sendResponse(id: number, result: unknown): void {
    if (!this.ws || !this.connected) return
    const frame = { jsonrpc: '2.0', id, result }
    this.ws.send(JSON.stringify(frame))
  }

  private send<T>(method: string, params?: unknown): Promise<T> {
    if (!this.ws || !this.connected)
      return Promise.reject(new Error('not connected'))
    const id = this.nextId++
    const frame: RpcRequest = { jsonrpc: '2.0', id, method }
    if (params !== undefined) frame.params = params
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      this.ws!.send(JSON.stringify(frame), err => {
        if (err) {
          this.pending.delete(id)
          reject(err)
        }
      })
    })
  }

  // --- public methods --------------------------------------------------

  initialize(clientInfo: ClientInfo): Promise<InitializeResponse> {
    return this.send<InitializeResponse>('initialize', {
      clientInfo,
      capabilities: null,
    })
  }

  /**
   * Audit rule #1: this method INTENTIONALLY sends an empty params object.
   * No `baseInstructions`, no `developerInstructions`, no `personality`,
   * no `model`, no `approvalPolicy`, no `sandbox` — codex reads everything
   * from ~/.codex/config.toml.
   *
   * The `cwd` parameter is permitted because TG users may want different
   * working directories per chat (per-chat workspace). Defaults to the
   * server's cwd if omitted.
   */
  threadStart(cwd?: string): Promise<ThreadStartResponse> {
    const params: Record<string, unknown> = {}
    if (cwd) params.cwd = cwd
    return this.send<ThreadStartResponse>('thread/start', params)
  }

  threadResume(threadId: string): Promise<ThreadStartResponse> {
    return this.send<ThreadStartResponse>('thread/resume', { threadId })
  }

  /**
   * Audit rule #2 + #3: send only `threadId` and the raw user text wrapped
   * in a single `UserInput` of type "text". No model / personality / effort
   * overrides. No prompt prefix / suffix.
   */
  turnStart(threadId: string, text: string): Promise<unknown> {
    return this.send('turn/start', {
      threadId,
      input: [{ type: 'text', text, text_elements: [] }],
    })
  }

  turnInterrupt(threadId: string, turnId: string): Promise<unknown> {
    return this.send('turn/interrupt', { threadId, turnId })
  }
}
