import dotenv from 'dotenv'
import { access, mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { config, higgsfield } from '@higgsfield/client/v2'

dotenv.config({ path: '.env.local' })
const credentials = process.env.HF_CREDENTIALS
if (!credentials) throw new Error('HF_CREDENTIALS is missing from the server environment.')
config({ credentials })

const scenes = [
  {
    name: '01-x402-payment',
    prompt: 'A single ten-second premium fintech brand-film shot. An abstract agent-to-service exchange: a precise pulse leaves a quiet autonomous network node, crosses a deep midnight-navy space, and unlocks a distant service node with a small restrained acid-lime light. A subtle transfer of luminous value is visible in the connection itself. Cinematic macro photography of physical light and glass, deliberate camera glide, elegant negative space, beautiful controlled reflections, fine film grain. Cohesive visual language: midnight navy, graphite, warm silver, one acid-lime highlight. No people, no coins with logos, no legible text, no numbers, no symbols, no interface, no screens, no montage, no extra shots.',
  },
  {
    name: '02-define-the-job',
    prompt: 'A single ten-second premium fintech brand-film shot. A vague cloud of small luminous particles gradually resolves into one clear, elegant geometric task object suspended above a dark navy surface; a precise lime outline settles around its edges like terms becoming clear. Camera performs a slow, assured orbit and pushes in. Physical materiality, sculptural glass, graphite and warm silver, restrained acid-lime details, rich shadows, luminous volumetric rays, meticulous composition, fine film grain. No readable text, no letters, no digits, no UI, no screens, no logos, no people, no jump cuts.',
  },
  {
    name: '03-escrow',
    prompt: 'A single ten-second premium fintech brand-film shot. A reserved stream of silver light representing a job budget moves into a transparent, finely machined vault suspended in deep midnight navy; the vault closes with calm precision and the light remains safely held behind layered glass. Small acid-lime edge lights, luxurious restrained financial-product art direction, slow lateral camera move, soft volumetric haze, tactile brushed metal, high contrast, subtle film grain. Do not release the light in this shot. No people, no banknotes, no coins, no text, no symbols, no interface, no screens, no logo, no montage.',
  },
  {
    name: '04-worker-delivers',
    prompt: 'A single ten-second premium fintech brand-film shot. An abstract autonomous worker, expressed only as a precise articulated graphite mechanism with a small acid-lime core, transforms a stream of raw fragments into one beautifully finished crystalline artifact. The artifact is presented toward camera while the worker withdraws from the frame, clearly showing the deliverable is separate from the worker. Midnight navy environment, silver reflections, measured kinetic energy, graceful one-shot camera arc, soft volumetric lighting, premium product-film craft, fine grain. No human figure, no hands, no text, no letters, no digits, no UI, no screens, no logo, no scene changes.',
  },
  {
    name: '05-independent-review',
    prompt: 'A single ten-second premium fintech brand-film shot. A finished crystalline work artifact enters an independent evaluation chamber, visibly separate from the worker mechanism: concentric dark-glass rings rotate on their own axis and a clean white-silver scanning plane passes over the artifact from a separate direction. The evaluator is an impartial ring structure, never attached to the worker. The scan resolves into a quiet acid-lime confirmation glow at the end. Cinematic close-up, deliberate camera push, midnight navy, graphite, glass, precise restrained motion, premium financial technology brand film, subtle film grain. No text, no checkmark glyphs, no digits, no UI, no screens, no people, no logo, no cuts.',
  },
  {
    name: '06-release-and-proof',
    prompt: 'A single ten-second premium fintech brand-film closing shot. Following a clear luminous acid-lime pass pulse, the separate transparent escrow vault opens for the first time; its held silver light travels in a clean deliberate line to the finished work artifact, then a small crystalline proof object remains in the center while the light settles. Convey conditional payment followed by a durable verified work record through shape and motion alone. Heroic but restrained final camera pull-back, deep midnight navy, controlled lime accent, polished glass and graphite, subtle film grain, premium product brand film. No readable text, letters, symbols or UI, no screens, no logos, no people, no additional scene.',
  },
]

async function main() {
  const outputDir = resolve('var/higgsfield/handsel-explainer-scenes')
  await mkdir(outputDir, { recursive: true })
  for (const scene of scenes) {
    const output = resolve(outputDir, `${scene.name}.mp4`)
    try {
      await access(output)
      throw new Error(`Refusing to submit a duplicate generation; output already exists: ${output}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  for (const scene of scenes) {
    console.log(`Submitting one Seedance 2.5 API request for ${scene.name}.`)
    const result = await higgsfield.subscribe('bytedance/seedance-2.5/text-to-video', {
      input: {
        prompt: scene.prompt,
        duration: 10,
        resolution: '720p',
        aspect_ratio: '16:9',
        output_format: 'mp4',
        generate_audio: false,
      },
      withPolling: true,
    })

    if (result.status !== 'completed' || !result.video?.url) {
      throw new Error(`${scene.name} did not complete with a video URL (status: ${result.status}); no generation was retried.`)
    }

    const response = await fetch(result.video.url)
    const contentType = response.headers.get('content-type') ?? ''
    if (!response.ok || !contentType.toLowerCase().startsWith('video/')) {
      throw new Error(`${scene.name} download failed validation (HTTP ${response.status}; ${contentType || 'missing MIME type'}); no generation was retried.`)
    }
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length === 0) throw new Error(`${scene.name} download was empty; no generation was retried.`)

    const output = resolve(outputDir, `${scene.name}.mp4`)
    await writeFile(output, bytes, { flag: 'wx' })
    console.log(`Completed ${scene.name}; video URL: ${result.video.url}`)
    console.log(`Saved ${output} (${bytes.length} bytes; ${contentType}).`)
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Explainer generation failed; no generation was retried.')
  process.exitCode = 1
})
