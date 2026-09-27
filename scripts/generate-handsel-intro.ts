import dotenv from 'dotenv'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { config, higgsfield } from '@higgsfield/client/v2'

dotenv.config({ path: '.env.local' })
const credentials = process.env.HF_CREDENTIALS
if (!credentials) throw new Error('HF_CREDENTIALS is missing from the server environment.')
config({ credentials })

async function main() {
  const result = await higgsfield.subscribe('bytedance/seedance-2.5/text-to-video', {
    input: {
      prompt: 'A refined cinematic product brand film, exactly five seconds, abstract motion graphics on a deep midnight navy background with restrained acid-lime light accents. Clearly communicate four sequential stages using only shape and movement, absolutely no lettering, numbers, symbols or interface text: a small luminous task token leaves a calm workspace node; moves into a distinct concentric independent-review ring with a second separate light sweeping across it; the review ring opens with a clean lime pass glow; the token travels to a secure escrow vault shape which releases a stream of lime light only after the pass. Elegant slow camera drift, precise geometry, soft film grain, premium financial technology art direction, high contrast, tasteful restraint, no people, no logos, no readable text, no fake UI, no extra scenes.',
      duration: 5,
      resolution: '720p',
      aspect_ratio: '16:9',
      output_format: 'mp4',
      generate_audio: false,
    },
    withPolling: true,
  })

  const videoUrl = result.status === 'completed' ? result.video?.url : undefined
  if (!videoUrl || /moderated|nsfw|cancel/i.test(String(result.status))) {
    throw new Error(`Intro generation did not complete with a video URL (status: ${result.status}).`)
  }

  const response = await fetch(videoUrl)
  const contentType = response.headers.get('content-type') ?? ''
  if (!response.ok || !contentType.toLowerCase().startsWith('video/')) {
    throw new Error(`Intro download failed validation (HTTP ${response.status}, ${contentType || 'missing MIME type'}).`)
  }

  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length === 0) throw new Error('Intro download was empty.')
  const output = resolve('public/media/handsel-intro.mp4')
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, bytes, { flag: 'wx' })
  console.log(`Saved ${output} (${bytes.length} bytes; ${contentType}).`)
}

main().catch(() => {
  console.error('Intro generation or download failed. The request was not retried.')
  process.exitCode = 1
})
