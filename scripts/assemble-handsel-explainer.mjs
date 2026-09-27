import { mkdir, stat, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import ffmpegPath from 'ffmpeg-static'

if (!ffmpegPath) throw new Error('ffmpeg-static did not provide a binary for this platform.')

const sceneNames = [
  '01-x402-payment',
  '02-define-the-job',
  '03-escrow',
  '04-worker-delivers',
  '05-independent-review',
  '06-release-and-proof',
]
const scenePaths = sceneNames.map((name) => resolve('var/higgsfield/handsel-explainer-scenes', `${name}.mp4`))
const outputPath = resolve('public/media/handsel-explainer.mp4')
const posterPath = resolve('public/media/handsel-explainer-poster.jpg')
const subtitlesPath = resolve('.next/handsel-explainer.ass')
const fade = 0.35
const sceneDuration = 10

for (const path of scenePaths) {
  const info = await stat(path)
  if (info.size === 0) throw new Error(`A required scene file is empty: ${path}`)
}
const ass = `[Script Info]
Title: Handsel — x402 pays. Proof first.
ScriptType: v4.00+
WrapStyle: 2
ScaledBorderAndShadow: yes
PlayResX: 1280
PlayResY: 720

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Eyebrow,Arial,16,&H0073FAC9,&H0073FAC9,&H901B1007,&H901B1007,1,0,0,0,100,100,2,0,1,2,0,2,82,82,152,1
Style: Main,Arial,43,&H00F3F6F2,&H00F3F6F2,&H901B1007,&H901B1007,1,0,0,0,100,100,0,0,1,2,1,2,82,82,78,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.70,0:00:05.60,Main,,0,0,0,,{\\fad(350,400)}{\\rEyebrow}PAYMENTS FOR AGENT SERVICES\\N{\\rMain}x402 moves value.
Dialogue: 0,0:00:10.25,0:00:15.60,Main,,0,0,0,,{\\fad(350,400)}{\\rEyebrow}PAYMENT IS NOT PROOF\\N{\\rMain}A paid call can’t grade the work.
Dialogue: 0,0:00:19.80,0:00:25.15,Main,,0,0,0,,{\\fad(350,400)}{\\rEyebrow}AGREE ON THE OUTCOME\\N{\\rMain}Set the terms. Hold the bounty in escrow.
Dialogue: 0,0:00:29.45,0:00:34.80,Main,,0,0,0,,{\\fad(350,400)}{\\rEyebrow}WORK AGAINST THE TERMS\\N{\\rMain}A worker completes and submits the task.
Dialogue: 0,0:00:39.10,0:00:44.45,Main,,0,0,0,,{\\fad(350,400)}{\\rEyebrow}INDEPENDENT EVALUATION\\N{\\rMain}A separate reviewer checks the evidence.
Dialogue: 0,0:00:48.75,0:00:54.10,Main,,0,0,0,,{\\fad(350,400)}{\\rEyebrow}SETTLE ON THE VERDICT\\N{\\rMain}Pass review. Release payment. Keep proof.
Dialogue: 0,0:00:54.70,0:00:58.20,Main,,0,0,0,,{\\fad(250,500)}{\\rEyebrow}HANDSEL\\N{\\rMain}x402 pays. Proof first.
`
await mkdir(resolve('.next'), { recursive: true })
await writeFile(subtitlesPath, ass)

const inputs = scenePaths.flatMap((path) => ['-i', path])
const normalized = scenePaths.map((_, i) => `[${i}:v]scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,setsar=1,fps=30,format=yuv420p,settb=AVTB,setpts=PTS-STARTPTS[v${i}]`)
const filters = [...normalized]
let current = 'v0'
for (let i = 1; i < scenePaths.length; i++) {
  const next = `v${i}`
  const output = `vx${i}`
  const offset = (sceneDuration - fade) * i
  filters.push(`[${current}][${next}]xfade=transition=fade:duration=${fade}:offset=${offset}[${output}]`)
  current = output
}
filters.push(`[${current}]subtitles=filename=.next/handsel-explainer.ass[vout]`)

const args = [
  '-hide_banner', '-y', ...inputs,
  '-filter_complex', filters.join(';'),
  '-map', '[vout]', '-an',
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-pix_fmt', 'yuv420p',
  '-movflags', '+faststart', '-t', String(sceneNames.length * sceneDuration - fade * (sceneNames.length - 1)),
  outputPath,
]

await new Promise((resolvePromise, reject) => {
  const child = spawn(ffmpegPath, args, { stdio: 'inherit', windowsHide: true })
  child.on('error', reject)
  child.on('exit', (code) => code === 0 ? resolvePromise() : reject(new Error(`FFmpeg exited with code ${code}.`)))
})

const finalInfo = await stat(outputPath)
if (finalInfo.size === 0) throw new Error('The assembled explainer file is empty.')
const posterArgs = ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '2.5', '-i', outputPath, '-frames:v', '1', '-q:v', '2', posterPath]
await new Promise((resolvePromise, reject) => {
  const child = spawn(ffmpegPath, posterArgs, { stdio: 'inherit', windowsHide: true })
  child.on('error', reject)
  child.on('exit', (code) => code === 0 ? resolvePromise() : reject(new Error(`Poster extraction exited with code ${code}.`)))
})
const posterInfo = await stat(posterPath)
if (posterInfo.size === 0) throw new Error('The explainer poster is empty.')
console.log(`Assembled ${outputPath} (${finalInfo.size} bytes, about 58 seconds).`)
console.log(`Poster ${posterPath} (${posterInfo.size} bytes).`)
