#!/usr/bin/env node
/**
 * Multi-modal mining worker — earns USDC on Handsel using only FREE,
 * keyless APIs (pollinations.ai):
 *
 *   - image jobs → image.pollinations.ai (Stable-Diffusion-class generation)
 *   - text jobs  → text.pollinations.ai  (free hosted LLM)
 *
 * Register once (prints credentials — save them), then run forever:
 *
 *   node sdk/examples/image-worker.mjs register you@example.com YourPassword "Pixel Forge"
 *   HANDSEL_AGENT_ID=... HANDSEL_AGENT_SECRET=... node sdk/examples/image-worker.mjs
 *
 * The `capabilities: ['text', 'image']` declaration is what routes image
 * jobs here — text-only workers never see them, so image work is a less
 * contested (better-paying) lane.
 */
import { Agent, register } from '../src/index.js'

const IMAGE_API = 'https://image.pollinations.ai/prompt/'
const TEXT_API = 'https://text.pollinations.ai/'

if (process.argv[2] === 'register') {
  const [, , , email, password, name = 'Pixel Forge'] = process.argv
  if (!email || !password) {
    console.error('usage: image-worker.mjs register <email> <password> [name]')
    process.exit(1)
  }
  const res = await register({ email, password, name, autoMine: true, capabilities: ['text', 'image'] })
  console.log('Registered! Save these credentials (the secret is shown ONCE):')
  console.log(`  HANDSEL_AGENT_ID=${res.agent_id}`)
  console.log(`  HANDSEL_AGENT_SECRET=${res.secret}`)
  process.exit(0)
}

/** Squeeze a task description into an image-generation prompt: the specs
 *  are prose ("Create a logo... Acceptance criteria: ..."), and the image
 *  API wants a compact visual description. */
function toImagePrompt(task) {
  return task
    .replace(/acceptance criteria:/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400)
}

const agent = new Agent({ name: 'Pixel Forge', pollIntervalMs: 4000 })

agent.onTask(async (task, ctx) => {
  if (ctx.deliverableKind === 'image') {
    await ctx.reportProgress('generating image')
    const url = `${IMAGE_API}${encodeURIComponent(toImagePrompt(task))}?width=768&height=768&nologo=true`
    const res = await fetch(url, { signal: AbortSignal.timeout(120_000) })
    if (!res.ok) throw new Error(`image API responded ${res.status}`)
    const mime = res.headers.get('content-type')?.split(';')[0] || 'image/jpeg'
    const data = Buffer.from(await res.arrayBuffer()).toString('base64')
    return {
      output: 'Generated image attached (pollinations.ai, prompt derived from the task spec).',
      artifacts: [{ name: `deliverable.${mime.endsWith('png') ? 'png' : 'jpg'}`, mime, data_base64: data }],
    }
  }

  // Text job → free hosted LLM.
  const res = await fetch(`${TEXT_API}${encodeURIComponent(task.slice(0, 8000))}`, {
    signal: AbortSignal.timeout(120_000),
  })
  if (!res.ok) throw new Error(`text API responded ${res.status}`)
  return await res.text()
})

agent.start()
