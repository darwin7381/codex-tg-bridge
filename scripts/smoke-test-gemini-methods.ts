/**
 * Live test of the gemini ACP control methods we just added.
 * Spawns its own gemini --acp subprocess (independent of the live
 * bridge) so we don't disturb production state.
 *
 * Run: bun scripts/smoke-test-gemini-methods.ts
 */

import { GeminiClient } from '../src/gemini-client.ts'

async function tryRpc<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    const r = await fn()
    console.log(`✅ ${label}`)
    console.log(`   →`, JSON.stringify(r, null, 2).slice(0, 800))
    return r
  } catch (err) {
    console.log(`❌ ${label}: ${(err as Error).message}`)
    return null
  }
}

async function main(): Promise<void> {
  const c = new GeminiClient()
  c.on('error', e => console.error('  client error:', (e as Error).message))
  c.on('stderr', () => {})

  await c.start()
  console.log('spawned gemini --acp\n')

  // 1. initialize
  await tryRpc('initialize', () => c.initialize({ name: 'smoke', version: '0.1' }))

  // 2. session/new (baseline — known to work)
  const ns = await tryRpc('session/new', () => c.sessionNew())
  const sid: string | undefined = (ns as any)?.sessionId
  if (!sid) {
    console.log('  ⚠️ no sessionId — bailing on session-dependent tests')
    c.stop()
    setTimeout(() => process.exit(1), 100)
    return
  }

  // 3. session/list
  await tryRpc('session/list (no cwd filter)', () => c.sessionList())
  await tryRpc('session/list (with cwd=process.cwd())', () => c.sessionList(process.cwd()))

  // 4. session/set_mode (each known mode)
  for (const mode of ['default', 'autoEdit', 'yolo', 'plan']) {
    await tryRpc(`session/set_mode ${mode}`, () => c.sessionSetMode(sid, mode))
  }

  // 5. session/set_model — query the available list first via the
  //    session/new response we already have; just try a known model id.
  await tryRpc('session/set_model auto-gemini-3', () => c.sessionSetModel(sid, 'auto-gemini-3'))

  // 6. session/fork
  await tryRpc('session/fork', () => c.sessionFork(sid))

  // 7. session/resume (different from session/load — ACP experimental)
  await tryRpc('session/resume', () => c.sessionResume(sid))

  // 8. session/load (the older non-experimental load)
  await tryRpc('session/load', () => c.sessionLoad(sid))

  // 9. Slash command via prompt: send "/memory show"
  await tryRpc('prompt with "/memory show" (gemini should intercept internally)', () =>
    c.sessionPrompt(sid, '/memory show'),
  )

  c.stop()
  await new Promise(r => setTimeout(r, 300))
  process.exit(0)
}

main().catch(err => {
  console.error('FATAL:', err)
  process.exit(1)
})
