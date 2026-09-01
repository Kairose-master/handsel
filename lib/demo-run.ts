/**
 * Zero-friction public demo engine. Runs the SAME generators the desktop
 * miners use (pollinations image, Google TTS audio, the platform LLM for
 * text) and the SAME independent graders the labor market settles with
 * (vision / transcription / LLM review) — but synchronously and without any
 * wallet, escrow, or on-chain ceremony, so a first-time visitor sees real
 * graded output in seconds. Keys come from the house faucet account.
 *
 * Honesty: nothing here is faked. It is the production pipeline with the
 * money rails removed for a try-before-you-sign-up sandbox.
 */
import { db } from '@/lib/db'
import { user } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'

export type DemoKind = 'text' | 'image' | 'audio'

export interface DemoResult {
  kind: DemoKind
  textOutput?: string
  mediaDataUrl?: string
  mediaMime?: string
  verdict: { passed: boolean | null; reason: string }
  /** Set when the deliverable passed grading: a gas-free authorship+grade proof
   *  (keccak256 fingerprint + oracle signature) verifiable at /proof/<id>. */
  proof?: { id: string; contentHash: string; attester: string }
}

/** Issue a Proof of Authorship & Grade for a passing demo deliverable.
 *  Best-effort — a proof failure never breaks the demo response. */
async function attachProof(
  kind: DemoKind,
  passed: boolean | null,
  deliverable: { base64?: string | null; text?: string | null },
  grader: string,
): Promise<DemoResult['proof']> {
  if (passed !== true) return undefined
  const { issueWorkProof } = await import('@/lib/work-proof-store')
  const stored = await issueWorkProof({
    jobRef: `demo-${kind}-${Date.now()}`,
    kind,
    worker: 'demo-worker@handsel',
    requester: FAUCET_EMAIL,
    grader,
    deliverable,
  })
  return stored ? { id: stored.id, contentHash: stored.proof.contentHash, attester: stored.attester } : undefined
}

const FAUCET_EMAIL = 'faucet@handsel.internal'
const IMAGE_API = 'https://image.pollinations.ai/prompt/'
const TTS_API = 'https://translate.google.com/translate_tts'

async function faucetOwnerId(): Promise<string | null> {
  const [owner] = await db.select({ id: user.id }).from(user).where(eq(user.email, FAUCET_EMAIL))
  if (owner) return owner.id
  // The demo borrows the faucet's system user, and on deployments where the
  // faucet never ran (mainnet — it is a testnet feature) that row does not
  // exist, so every "Run it now" on /try was a 500 on exactly the deployment
  // the promo domain points at. The demo moves no money, so it provisions the
  // row itself (find-or-create, password-less — nobody can log into it)
  // instead of waiting on a feature that will never run here.
  const { ensureFaucetAgent } = await import('@/lib/job-faucet')
  const created = await ensureFaucetAgent().catch(() => null)
  return created?.userId ?? null
}

export async function generateImage(prompt: string): Promise<{ mime: string; base64: string }> {
  const clean = prompt.replace(/\s+/g, ' ').trim().slice(0, 400)

  // Prefer Hugging Face FLUX when a token is configured — higher quality and
  // more reliable than the keyless fallback. Falls through to pollinations if
  // HF is unconfigured or fails.
  const { generateHfImage } = await import('@/lib/hf-image')
  const hf = await generateHfImage(clean)
  if (hf) return hf

  const url = `${IMAGE_API}${encodeURIComponent(clean)}?width=1024&height=1024&nologo=true`
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) })
  if (!res.ok) throw new Error(`image API responded ${res.status}`)
  const mime = (res.headers.get('content-type') ?? 'image/jpeg').split(';')[0]
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > 4 * 1024 * 1024) throw new Error('generated image too large')
  return { mime, base64: buf.toString('base64') }
}

export async function generateAudio(script: string): Promise<{ mime: string; base64: string }> {
  // Prefer Hugging Face TTS (Kokoro) when a token + credits are available —
  // a far more natural voice than the keyless fallback. Falls through to
  // Google-Translate TTS if HF is unconfigured, out of credits, or fails.
  const { generateHfAudio } = await import('@/lib/hf-audio')
  const hf = await generateHfAudio(script)
  if (hf) return hf

  const words = script.replace(/\s+/g, ' ').trim().slice(0, 400).split(' ')
  const chunks: string[] = []
  let cur = ''
  for (const w of words) {
    if (cur.length + w.length + 1 > 180 && cur) {
      chunks.push(cur)
      cur = ''
    }
    cur = cur ? `${cur} ${w}` : w
  }
  if (cur) chunks.push(cur)

  const parts: Buffer[] = []
  let i = 0
  for (const chunk of chunks.slice(0, 6)) {
    const url = `${TTS_API}?ie=UTF-8&tl=en&client=tw-ob&idx=${i}&q=${encodeURIComponent(chunk)}`
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(30_000) })
    if (!res.ok) throw new Error(`TTS responded ${res.status}`)
    parts.push(Buffer.from(await res.arrayBuffer()))
    i++
  }
  return { mime: 'audio/mpeg', base64: Buffer.concat(parts).toString('base64') }
}

export async function runDemo(kind: DemoKind, prompt: string): Promise<DemoResult> {
  const ownerId = await faucetOwnerId()
  const spec = { title: prompt.slice(0, 120), description: null as string | null, acceptanceCriteria: prompt }

  if (kind === 'image') {
    const img = await generateImage(prompt)
    const { gradeImageSubmission } = await import('@/lib/vision-grading')
    const g = await gradeImageSubmission(spec, [{ mime: img.mime, dataBase64: img.base64, url: null }], ownerId)
    return {
      kind,
      mediaDataUrl: `data:${img.mime};base64,${img.base64}`,
      mediaMime: img.mime,
      verdict: { passed: g.passed, reason: g.output },
      proof: await attachProof(kind, g.passed, { base64: img.base64 }, 'vision'),
    }
  }

  if (kind === 'audio') {
    const au = await generateAudio(prompt)
    const { gradeAudioSubmission } = await import('@/lib/audio-grading')
    const g = await gradeAudioSubmission(spec, [{ mime: au.mime, dataBase64: au.base64, url: null }], ownerId)
    return {
      kind,
      mediaDataUrl: `data:${au.mime};base64,${au.base64}`,
      mediaMime: au.mime,
      verdict: { passed: g.passed, reason: g.output },
      proof: await attachProof(kind, g.passed, { base64: au.base64 }, 'transcription'),
    }
  }

  // text: generate with the platform LLM, then LLM-grade against the request.
  if (!ownerId) throw new Error('demo engine not configured')
  const { resolveLlm } = await import('@/lib/delegation')
  const complete = await resolveLlm(ownerId)
  const output = await complete(
    'You are a capable worker agent completing a client request. Produce ONLY the deliverable — no preamble, no meta commentary.',
    prompt,
    1200,
  )
  const { gradeTextSubmission } = await import('@/lib/text-grading')
  const g = await gradeTextSubmission(
    { title: spec.title, description: null, acceptanceCriteria: `The output fully satisfies this request: ${prompt}` },
    output,
    ownerId,
  )
  return {
    kind,
    textOutput: output,
    verdict: { passed: g.passed, reason: g.output },
    proof: await attachProof(kind, g.passed, { text: output }, 'llm'),
  }
}
