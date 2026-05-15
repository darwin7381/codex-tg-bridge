/**
 * Smoke test for GeminiClient: spawn `gemini --acp` → initialize →
 * session/new → session/prompt → observe session/update events →
 * await session/prompt response (carries stopReason).
 *
 * Same shape as scripts/smoke-test.ts (codex side) for parity.
 *
 * Run: `cd ~/codex-tg-bridge && bun scripts/smoke-test-gemini.ts`
 *
 * Pre-flight: gemini-cli is logged in via Google OAuth (`gemini auth`),
 * NO `GEMINI_API_KEY` / `GOOGLE_API_KEY` / `GOOGLE_GENAI_USE_VERTEXAI`
 * env vars set.
 */

import { GeminiClient } from '../src/gemini-client.ts'

const PROMPT = process.argv.slice(2).join(' ') || 'Reply with exactly: pong'

async function main(): Promise<void> {
  const c = new GeminiClient()
  c.on('stderr', (line: string) => {
    // Surface gemini-cli init noise so the user knows what's going on
    if (line) console.log(`  [gemini stderr] ${line.slice(0, 200)}`)
  })
  c.on('error', err => console.error('  error:', (err as Error).message))
  c.on('exit', (code, signal) => console.log(`  [gemini exit] code=${code} signal=${signal}`))

  await c.start()
  console.log('spawned gemini --acp')

  const init = await c.initialize({ name: 'smoke-test', version: '0.0.1' })
  console.log(
    `initialize → ${init.agentInfo.name} v${init.agentInfo.version}, ` +
      `authMethods=${init.authMethods.map(a => a.id).join(',')}`,
  )

  const s = await c.sessionNew()
  console.log(`session/new → sessionId=${s.sessionId}`)

  console.log(`\nlistening for session/update during turn ("${PROMPT}"):`)
  c.on('notification', (method: string, params: any) => {
    if (method === 'session/update') {
      const u = params?.update
      const kind = u?.sessionUpdate ?? '?'
      if (kind === 'agent_message_chunk') {
        // Don't spam — just dot
        process.stdout.write('.')
      } else if (kind === 'tool_call') {
        console.log(`  ← tool_call: ${u.title ?? '?'} (kind=${u.kind ?? '?'})`)
      } else if (kind === 'tool_call_update') {
        console.log(`  ← tool_call_update: ${u.toolCallId?.slice(0, 8) ?? '?'} status=${u.status ?? '?'}`)
      } else if (kind === 'plan') {
        console.log(`  ← plan`)
      } else {
        console.log(`  ← session/update: ${kind}`)
      }
    } else {
      console.log(`  ← ${method}`)
    }
  })

  const promptStart = Date.now()
  const response = await c.sessionPrompt(s.sessionId, PROMPT)
  console.log(`\n✓ session/prompt completed in ${Date.now() - promptStart}ms — stopReason=${response.stopReason}`)
  c.stop()
  await new Promise(r => setTimeout(r, 200))
  process.exit(0)
}

main().catch(err => {
  console.error('FATAL:', err)
  process.exit(1)
})
