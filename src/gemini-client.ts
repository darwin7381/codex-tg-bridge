/**
 * gemini-cli ACP stdio JSON-RPC client.
 *
 * Spawns `gemini --acp` as a long-lived subprocess and speaks the
 * Agent Client Protocol (https://agentclientprotocol.com) over its
 * stdin/stdout with NDJSON framing (one JSON object per line).
 *
 * Five audit invariants — same intent as codex-client, mapped to ACP:
 *   #1 session/new sends NO `instructions` / `systemPrompt` / `model`
 *      override. Gemini reads ~/.gemini/config + AGENTS.md / .gemini
 *      defaults itself.
 *   #2 session/prompt sends ONLY the raw user text as a `text` block.
 *      No tool override, no per-prompt system framing.
 *   #3 user TG message → session/prompt content[0].text is byte-for-byte
 *      the raw text.
 *   #4 session/update events are forwarded verbatim to listeners.
 *   #5 ~/.gemini config + cached OAuth credentials are the single
 *      source of auth + config truth. We refuse to start if
 *      `GEMINI_API_KEY` / `GOOGLE_API_KEY` / `GOOGLE_GENAI_USE_VERTEXAI`
 *      are set in env (auto-switches gemini-cli to pay-per-token API
 *      billing — see the $150 trap).
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'

// --- types ---------------------------------------------------------------

export type ClientInfo = { name: string; title?: string; version: string }

export type InitializeResponse = {
  protocolVersion: number
  authMethods: Array<{ id: string; name: string; description?: string }>
  agentInfo: { name: string; title: string; version: string }
  agentCapabilities: {
    loadSession?: boolean
    promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean }
    mcpCapabilities?: { http?: boolean; sse?: boolean }
  }
}

export type NewSessionParams = {
  cwd?: string
  mcpServers?: unknown[]
}

export type NewSessionResponse = {
  sessionId: string
  [k: string]: unknown
}

export type PromptResponse = {
  stopReason: 'end_turn' | 'max_tokens' | 'cancelled' | 'refusal' | string
}

export type PermissionOption = { optionId: string; name: string; kind?: string }

// --- JSON-RPC framing ----------------------------------------------------

type RpcRequest = { jsonrpc: '2.0'; id: number; method: string; params?: unknown }
type RpcSuccess = { jsonrpc?: '2.0'; id: number; result: unknown }
type RpcError = { jsonrpc?: '2.0'; id: number; error: { code: number; message: string; data?: unknown } }
type RpcNotification = { jsonrpc?: '2.0'; method: string; params?: unknown }
type RpcServerRequest = { jsonrpc?: '2.0'; id: number; method: string; params?: unknown }

function isResponse(m: any): m is RpcSuccess | RpcError {
  return m && typeof m === 'object' && typeof m.id === 'number' && typeof m.method !== 'string' && ('result' in m || 'error' in m)
}
function isServerRequest(m: any): m is RpcServerRequest {
  return m && typeof m === 'object' && typeof m.id === 'number' && typeof m.method === 'string'
}
function isNotification(m: any): m is RpcNotification {
  return m && typeof m === 'object' && typeof m.method === 'string' && m.id === undefined
}

// --- subscription-safety guard -------------------------------------------

const API_KEY_ENV_VARS = ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI'] as const

export function assertSubscriptionBilling(env = process.env): void {
  const offenders = API_KEY_ENV_VARS.filter(k => env[k] && env[k]!.trim() !== '')
  if (offenders.length > 0) {
    throw new Error(
      `Refusing to start gemini --acp: env contains ${offenders.join(', ')} which switches ` +
        `gemini-cli to pay-per-token API billing. Unset these vars so the Google OAuth ` +
        `(Gemini subscription) auth path is used.\n` +
        `See: https://medium.com/@lhc1990/the-150-gemini-cli-trap`,
    )
  }
}

// --- client --------------------------------------------------------------

export class GeminiClient extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null
  private nextId = 1
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private stdoutBuf = ''

  constructor(
    private readonly geminiBinary = '/opt/homebrew/bin/gemini',
    private readonly extraArgs: ReadonlyArray<string> = [],
  ) {
    super()
  }

  /**
   * Spawn `gemini --acp` and resolve once stdin/stdout are wired up.
   * Refuses to start if env contains *_API_KEY (audit rule #5).
   */
  async start(): Promise<void> {
    if (this.proc) throw new Error('already started')

    assertSubscriptionBilling()

    const proc = spawn(this.geminiBinary, ['--acp', ...this.extraArgs], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    })
    this.proc = proc

    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', chunk => this.onStdout(chunk))

    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', chunk => {
      // gemini-cli prints non-JSON noise to stderr (Keychain init, auth,
      // skill loader). Surface as informational events so a wrapper can
      // log them; do not treat as errors.
      this.emit('stderr', String(chunk).trim())
    })

    proc.on('exit', (code, signal) => {
      this.emit('exit', code, signal)
      const err = new Error(`gemini --acp exited (code=${code}, signal=${signal})`)
      for (const { reject } of this.pending.values()) reject(err)
      this.pending.clear()
    })

    proc.on('error', err => this.emit('error', err))
  }

  stop(): void {
    if (!this.proc) return
    this.proc.kill('SIGTERM')
  }

  /** Drain stdout, frame on newlines, dispatch each JSON-RPC message. */
  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk
    let nl: number
    while ((nl = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, nl).trim()
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1)
      if (!line) continue
      let msg: unknown
      try {
        msg = JSON.parse(line)
      } catch {
        // gemini-cli sometimes emits non-JSON to stdout during startup
        // ("Loaded cached credentials." etc.). Treat as stderr-like.
        this.emit('stderr', line)
        continue
      }
      this.dispatch(msg)
    }
  }

  private dispatch(msg: unknown): void {
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
      // session/request_permission and friends — needs a JSON-RPC reply.
      this.emit('serverRequest', msg.method, msg.params, (result: unknown) =>
        this.sendResponse(msg.id, result),
      )
      this.emit(`request:${msg.method}`, msg.params, (result: unknown) =>
        this.sendResponse(msg.id, result),
      )
      return
    }
    if (isNotification(msg)) {
      // Audit rule #4: forward session/update + others verbatim.
      this.emit('notification', msg.method, msg.params)
      this.emit(`method:${msg.method}`, msg.params)
      return
    }
    this.emit('error', new Error(`unrecognized RPC frame: ${JSON.stringify(msg).slice(0, 200)}`))
  }

  private send<T>(method: string, params?: unknown): Promise<T> {
    if (!this.proc || !this.proc.stdin.writable)
      return Promise.reject(new Error('gemini subprocess not writable'))
    const id = this.nextId++
    const frame: RpcRequest = { jsonrpc: '2.0', id, method }
    if (params !== undefined) frame.params = params
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      this.proc!.stdin.write(JSON.stringify(frame) + '\n', err => {
        if (err) {
          this.pending.delete(id)
          reject(err)
        }
      })
    })
  }

  private sendResponse(id: number, result: unknown): void {
    if (!this.proc || !this.proc.stdin.writable) return
    const frame = { jsonrpc: '2.0', id, result }
    this.proc.stdin.write(JSON.stringify(frame) + '\n')
  }

  // --- public methods --------------------------------------------------

  initialize(clientInfo?: ClientInfo): Promise<InitializeResponse> {
    return this.send<InitializeResponse>('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        // We don't expose fs / terminal to the agent — the bridge is
        // a chat surface, not an IDE. gemini-cli's built-in tools
        // still work; the agent just can't call back to ask us to read
        // a file.
      },
      clientInfo: clientInfo ?? { name: 'gemini-tg-bridge', version: '0.1.0' },
    })
  }

  /**
   * Audit rule #1: empty params (no instructions, no systemPrompt,
   * no model override). `cwd` is REQUIRED by gemini-cli's ACP server
   * (validates non-undefined); default to process.cwd().
   */
  sessionNew(cwd?: string): Promise<NewSessionResponse> {
    const params: Record<string, unknown> = {
      cwd: cwd ?? process.cwd(),
      // gemini-cli's ACP server expects an MCP server list (can be
      // empty) per its current implementation. Pass empty array;
      // gemini will load its own ~/.gemini/settings.json MCP entries.
      mcpServers: [],
    }
    return this.send<NewSessionResponse>('session/new', params)
  }

  sessionLoad(sessionId: string, cwd?: string): Promise<NewSessionResponse> {
    const params: Record<string, unknown> = {
      sessionId,
      cwd: cwd ?? process.cwd(),
      mcpServers: [],
    }
    return this.send<NewSessionResponse>('session/load', params)
  }

  /**
   * Audit rules #2 + #3: send ONLY the raw user text wrapped as a single
   * `text` ContentBlock. No model override, no system framing. The
   * response carries `stopReason` when the turn ends.
   */
  sessionPrompt(sessionId: string, text: string): Promise<PromptResponse> {
    return this.send<PromptResponse>('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text }],
    })
  }

  sessionCancel(sessionId: string): Promise<unknown> {
    return this.send('session/cancel', { sessionId })
  }
}
