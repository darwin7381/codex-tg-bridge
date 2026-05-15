/**
 * Smoke test for CodexClient: connect → initialize → thread/start →
 * turn/start with a simple prompt → observe item/* notifications until
 * turn/completed.
 *
 * Bypasses Telegram entirely so we can verify the codex side of the bridge
 * works before a real bot is wired up.
 *
 * Run: `cd ~/codex-tg-bridge && bun scripts/smoke-test.ts`
 * Prereq: `codex app-server --listen ws://127.0.0.1:17651` running.
 */

import { CodexClient } from '../src/codex-client.ts'

const URL = process.env.CODEX_URL ?? 'ws://127.0.0.1:17651'
const PROMPT = process.argv.slice(2).join(' ') || 'Say hi back in one short sentence.'

async function main(): Promise<void> {
  const c = new CodexClient(URL)
  c.on('error', err => console.error('  error:', (err as Error).message))
  c.on('close', () => console.log('  [close]'))

  await c.connect()
  console.log(`connected to ${URL}`)

  const init = await c.initialize({ name: 'smoke-test', version: '0.0.1' })
  console.log(`initialize → userAgent="${init.userAgent}" codexHome=${init.codexHome} ${init.platformOs}`)

  const t = await c.threadStart()
  console.log(`thread/start → id=${t.thread.id} model=${t.model} cwd=${t.cwd}`)
  console.log(`instructionSources: ${JSON.stringify((t as any).instructionSources)}`)

  console.log(`\nlistening for notifications during turn ("${PROMPT}"):`)
  c.on('notification', (method: string, params: any) => {
    if (method === 'item/completed') {
      const item = params?.item
      const summary =
        item?.type === 'agentMessage' ? `: ${(item.text ?? '').slice(0, 100)}` : ''
      console.log(`  ← item/completed type=${item?.type}${summary}`)
    } else if (method === 'agentMessage/delta') {
      // Don't spam deltas — just record we got them
      process.stdout.write('.')
    } else {
      console.log(`  ← ${method}`)
    }
  })

  await c.turnStart(t.thread.id, PROMPT)
  console.log(`turn/start sent. waiting up to 60s for turn/completed...`)

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('turn/completed timeout after 60s')), 60_000)
    c.once('method:turn/completed', () => {
      clearTimeout(timer)
      resolve()
    })
  })

  console.log('\n✓ turn/completed received — codex side works end-to-end.')
  c.close()
  // Give the close event a tick to fire before process exits.
  await new Promise(r => setTimeout(r, 100))
  process.exit(0)
}

main().catch(err => {
  console.error('FATAL:', err)
  process.exit(1)
})
