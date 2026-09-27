import dotenv from 'dotenv'
import { config, higgsfield } from '@higgsfield/client/v2'

dotenv.config({ path: '.env.local' })
const credentials = process.env.HF_CREDENTIALS
if (!credentials) throw new Error('HF_CREDENTIALS is missing from the server environment.')

config({ credentials })

async function main() {
  const result = await higgsfield.subscribe('bytedance/seedance-2.5/text-to-video', {
    input: {
      prompt: 'A cinematic scene at sunset',
      duration: 5,
      resolution: '720p',
      aspect_ratio: '16:9',
    },
    withPolling: true,
  })

  const videoUrl = result.status === 'completed' ? result.video?.url : undefined
  if (!videoUrl || /moderated|nsfw|cancel/i.test(String(result.status))) {
    throw new Error(`Seedance example did not complete with a video URL (status: ${result.status}).`)
  }

  console.log(videoUrl)
}

main().catch(() => {
  console.error('Seedance example failed. The request was not retried.')
  process.exitCode = 1
})
