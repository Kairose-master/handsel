#!/usr/bin/env node
/**
 * Promo capture — screenshots and a screen recording of a RUNNING Handsel
 * deployment, for marketing assets.
 *
 * The claim discipline the Growth Studio template enforces on copy applies
 * to imagery too: a promo frame is a claim about what the product does.
 * Two rules follow:
 *
 *  1. Prefer REAL pages on a real deployment (this script's default mode).
 *     Public pages need no auth; /office needs a signed-in storage state —
 *     capture your own account's real office, never a staged one.
 *  2. If you must capture a mock/demo harness (e.g. the 3D office with
 *     sample agents because no signed-in session is available), the harness
 *     MUST render a visible "DEMO" badge so every frame self-discloses.
 *     Footage of invented agents presented as live activity is exactly the
 *     fabrication this platform exists to make impossible for work — do
 *     not produce it for marketing either.
 *
 * Usage:
 *   BASE_URL=https://handsel-main.vercel.app node scripts/promo-capture.mjs
 *   BASE_URL=http://localhost:3000 STORAGE_STATE=./auth.json VIDEO_PATH=/office \
 *     node scripts/promo-capture.mjs
 *
 * Env:
 *   BASE_URL        required — the deployment to capture
 *   OUT_DIR         default ./promo-out
 *   STORAGE_STATE   optional Playwright storageState JSON (a signed-in
 *                   session) — enables authenticated pages like /office.
 *                   Create one with: npx playwright codegen --save-storage=auth.json <BASE_URL>
 *   SHOTS           comma-separated paths to screenshot
 *                   (default: /guest,/live,/try,/credit-scores)
 *   VIDEO_PATH      optional single path to screen-record for ~30s while
 *                   this script scrolls it (omit to skip video)
 *   WIDTH/HEIGHT    viewport, default 1280x800
 *
 * Playwright is not a dependency of this repo; run where it's installed
 * (npx playwright@latest works) with its browsers present.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

function loadPlaywright() {
  const candidates = ['playwright', '/opt/pw-browsers/../node_modules/playwright', '/opt/node22/lib/node_modules/playwright']
  for (const c of candidates) {
    try {
      return require(c)
    } catch {
      /* next */
    }
  }
  console.error('playwright not found — run via `npx playwright@latest` env or install it globally.')
  process.exit(1)
}

const BASE_URL = process.env.BASE_URL
if (!BASE_URL) {
  console.error('BASE_URL is required, e.g. BASE_URL=https://handsel-main.vercel.app')
  process.exit(1)
}
const OUT_DIR = process.env.OUT_DIR ?? './promo-out'
const SHOTS = (process.env.SHOTS ?? '/guest,/live,/try,/credit-scores').split(',').map((s) => s.trim()).filter(Boolean)
const VIDEO_PATH = process.env.VIDEO_PATH || null
const WIDTH = Number(process.env.WIDTH) || 1280
const HEIGHT = Number(process.env.HEIGHT) || 800

const { chromium } = loadPlaywright()

const slug = (p) => p.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '') || 'home'

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const executablePath = process.env.CHROMIUM_PATH || undefined
  const browser = await chromium.launch({ executablePath })
  const contextOpts = { viewport: { width: WIDTH, height: HEIGHT } }
  if (process.env.STORAGE_STATE) contextOpts.storageState = process.env.STORAGE_STATE

  // Screenshots
  const ctx = await browser.newContext(contextOpts)
  const page = await ctx.newPage()
  for (const shot of SHOTS) {
    const url = new URL(shot, BASE_URL).toString()
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
      await page.waitForTimeout(2_500)
      const file = path.join(OUT_DIR, `${slug(shot)}.png`)
      await page.screenshot({ path: file, fullPage: false })
      console.log(`shot ${url} -> ${file}`)
    } catch (err) {
      console.error(`shot ${url} FAILED: ${err?.message ?? err}`)
    }
  }
  await ctx.close()

  // Video (one path, slow scroll)
  if (VIDEO_PATH) {
    const vctx = await browser.newContext({ ...contextOpts, recordVideo: { dir: OUT_DIR, size: { width: WIDTH, height: HEIGHT } } })
    const vpage = await vctx.newPage()
    const url = new URL(VIDEO_PATH, BASE_URL).toString()
    await vpage.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
    await vpage.waitForTimeout(4_000)
    for (let i = 0; i < 6; i++) {
      await vpage.mouse.wheel(0, 500)
      await vpage.waitForTimeout(3_000)
    }
    await vpage.waitForTimeout(3_000)
    const video = vpage.video()
    await vctx.close()
    if (video) {
      const saved = path.join(OUT_DIR, `${slug(VIDEO_PATH)}.webm`)
      await video.saveAs(saved)
      console.log(`video ${url} -> ${saved} (convert: ffmpeg -i in.webm -c:v libx264 -pix_fmt yuv420p out.mp4)`)
    }
  }

  await browser.close()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
