#!/usr/bin/env node
/**
 * Handsel Instagram publisher — standalone CLI over the OFFICIAL Graph API.
 *
 * Zero dependencies; credentials from env only:
 *   INSTAGRAM_ACCESS_TOKEN, INSTAGRAM_ACCOUNT_ID,
 *   INSTAGRAM_API_VERSION (default v25.0),
 *   INSTAGRAM_GRAPH_HOST (default graph.instagram.com; use graph.facebook.com
 *   for Facebook-Login tokens).
 *
 * SAFETY: every publish command is a DRY RUN unless --live is passed — it
 * prints exactly what would be published and exits. The token is sent in the
 * Authorization header (never the URL) and is never printed beyond last-4.
 *
 * This mirrors lib/social/instagram/ in the app; the app's queue remains the
 * preferred route because it adds approval, scheduling and retries.
 */

const HOST = process.env.INSTAGRAM_GRAPH_HOST?.trim() || 'graph.instagram.com'
const VERSION = process.env.INSTAGRAM_API_VERSION?.trim() || 'v25.0'
const TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN?.trim()
const ACCOUNT = process.env.INSTAGRAM_ACCOUNT_ID?.trim()

const args = process.argv.slice(2)
const cmd = args[0]
const flag = (name) => {
  const i = args.indexOf(`--${name}`)
  if (i === -1) return undefined
  const v = args[i + 1]
  return v === undefined || v.startsWith('--') ? true : v
}
const LIVE = args.includes('--live')

const last4 = (s) => (s && s.length >= 8 ? `…${s.slice(-4)}` : '(unset)')
const die = (msg) => {
  console.error(`error: ${msg}`)
  process.exit(1)
}

function requireCreds() {
  if (!TOKEN || !ACCOUNT) {
    die(
      'INSTAGRAM_ACCESS_TOKEN / INSTAGRAM_ACCOUNT_ID are not set. See docs/social/instagram.md for the Meta setup runbook.',
    )
  }
}

async function api(path, { method = 'GET', params = {} } = {}) {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== false)
  const encoded = new URLSearchParams(entries.map(([k, v]) => [k, String(v === true ? 'true' : v)]))
  const base = `https://${HOST}/${VERSION}/${path}`
  const url = method === 'GET' && [...encoded].length ? `${base}?${encoded}` : base
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: method === 'POST' ? encoded.toString() : undefined,
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    const e = body?.error ?? {}
    const kind = e.type === 'OAuthException' || e.code === 190 ? 'AUTH (reconnect the account — do NOT retry)' : `code ${e.code ?? res.status}`
    die(`Graph API ${method} ${path} → HTTP ${res.status} [${kind}] ${e.message ?? ''}`)
  }
  return body
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForContainer(id, { timeoutMs = 10 * 60_000 } = {}) {
  const start = Date.now()
  let delay = 3000
  for (;;) {
    const s = await api(id, { params: { fields: 'status_code,status' } })
    process.stdout.write(`  container ${id}: ${s.status_code}\n`)
    if (s.status_code === 'FINISHED' || s.status_code === 'PUBLISHED') return s
    if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') {
      die(`container ${id} is ${s.status_code}: ${s.status ?? ''} — create a NEW container; never re-publish this one.`)
    }
    if (Date.now() - start + delay > timeoutMs) die(`container ${id} still processing after ${Math.round((Date.now() - start) / 1000)}s — re-check later with: status --container ${id}`)
    await sleep(delay)
    delay = Math.min(delay * 1.5, 30_000)
  }
}

function dryRunGate(plan) {
  console.log('PLAN (dry run — nothing published):')
  console.log(JSON.stringify(plan, null, 2))
  if (!LIVE) {
    console.log('\nAdd --live to publish. A live publish is public and irreversible — confirm with the human first.')
    process.exit(0)
  }
}

async function publishContainer(containerId) {
  await waitForContainer(containerId)
  const pub = await api(`${ACCOUNT}/media_publish`, { method: 'POST', params: { creation_id: containerId } })
  const media = await api(pub.id, { params: { fields: 'id,permalink,media_type,timestamp' } }).catch(() => ({ id: pub.id }))
  console.log(`PUBLISHED  media=${media.id}  container=${containerId}  permalink=${media.permalink ?? '(pending)'}`)
}

const commands = {
  async doctor() {
    requireCreds()
    console.log(`host=${HOST} version=${VERSION} account=${ACCOUNT} token=${last4(TOKEN)}`)
    const me = await api(ACCOUNT, { params: { fields: 'id,username' } })
    console.log(`ok: token resolves account @${me.username ?? '?'} (${me.id})`)
    const q = await commands.quota()
    void q
  },

  async quota() {
    requireCreds()
    const res = await api(`${ACCOUNT}/content_publishing_limit`, { params: { fields: 'quota_usage,config' } })
    const row = res.data?.[0] ?? {}
    const used = row.quota_usage ?? 0
    const total = row.config?.quota_total ?? 100
    console.log(`quota: ${used}/${total} publishes used in the rolling 24h window`)
    return { used, total }
  },

  async post() {
    const image = flag('image')
    if (typeof image !== 'string') die('post needs --image <public https url>')
    const plan = { kind: 'post', image_url: image, caption: flag('caption'), alt_text: flag('alt'), is_ai_generated: Boolean(flag('ai-generated')) }
    dryRunGate(plan)
    requireCreds()
    const c = await api(`${ACCOUNT}/media`, {
      method: 'POST',
      params: { image_url: image, caption: flag('caption'), alt_text: flag('alt'), is_ai_generated: Boolean(flag('ai-generated')) },
    })
    await publishContainer(c.id)
  },

  async carousel() {
    const media = flag('media')
    if (typeof media !== 'string') die('carousel needs --media <url,url,…> (2–10)')
    const urls = media.split(',').map((s) => s.trim()).filter(Boolean)
    if (urls.length < 2 || urls.length > 10) die(`carousels take 2–10 items, got ${urls.length}`)
    dryRunGate({ kind: 'carousel', items: urls, caption: flag('caption'), is_ai_generated: Boolean(flag('ai-generated')) })
    requireCreds()
    const children = []
    for (const u of urls) {
      const isVideo = /\.(mp4|mov)(\?|$)/i.test(u)
      const params = isVideo
        ? { video_url: u, media_type: 'VIDEO', is_carousel_item: true }
        : { image_url: u, is_carousel_item: true }
      const c = await api(`${ACCOUNT}/media`, { method: 'POST', params })
      console.log(`  child ${children.length + 1}/${urls.length}: ${c.id}`)
      children.push(c.id)
    }
    for (const id of children) await waitForContainer(id)
    const parent = await api(`${ACCOUNT}/media`, {
      method: 'POST',
      // AI disclosure goes on the PARENT container only — the API rejects it on children.
      params: { media_type: 'CAROUSEL', children: children.join(','), caption: flag('caption'), is_ai_generated: Boolean(flag('ai-generated')) },
    })
    await publishContainer(parent.id)
  },

  async reel() {
    const video = flag('video')
    if (typeof video !== 'string') die('reel needs --video <public https mp4 url>')
    const plan = {
      kind: 'reel',
      video_url: video,
      caption: flag('caption'),
      cover_url: flag('cover'),
      share_to_feed: Boolean(flag('share-to-feed')),
      is_ai_generated: Boolean(flag('ai-generated')),
    }
    dryRunGate(plan)
    requireCreds()
    const c = await api(`${ACCOUNT}/media`, {
      method: 'POST',
      params: {
        video_url: video,
        media_type: 'REELS',
        caption: flag('caption'),
        cover_url: flag('cover'),
        share_to_feed: Boolean(flag('share-to-feed')),
        is_ai_generated: Boolean(flag('ai-generated')),
      },
    })
    await publishContainer(c.id)
  },

  async story() {
    const image = flag('image')
    const video = flag('video')
    if (typeof image !== 'string' && typeof video !== 'string') die('story needs --image or --video')
    dryRunGate({ kind: 'story', image_url: image, video_url: video, is_ai_generated: Boolean(flag('ai-generated')), note: 'plain media only — no stickers/polls/music via API' })
    requireCreds()
    const ai = Boolean(flag('ai-generated'))
    const params = typeof video === 'string' ? { video_url: video, media_type: 'STORIES', is_ai_generated: ai } : { image_url: image, media_type: 'STORIES', is_ai_generated: ai }
    const c = await api(`${ACCOUNT}/media`, { method: 'POST', params })
    await publishContainer(c.id)
  },

  async status() {
    requireCreds()
    const container = flag('container')
    if (typeof container !== 'string') die('status needs --container <id>')
    const s = await api(container, { params: { fields: 'status_code,status' } })
    console.log(`${container}: ${s.status_code}${s.status ? ` (${s.status})` : ''}`)
  },

  async insights() {
    requireCreds()
    const media = flag('media')
    if (typeof media !== 'string') die('insights needs --media <id>')
    const metrics = typeof flag('metrics') === 'string' ? flag('metrics') : 'reach,likes,comments,saved,shares'
    const res = await api(`${media}/insights`, { params: { metric: metrics } })
    for (const m of res.data ?? []) console.log(`${m.name}: ${m.values?.[0]?.value ?? 0}`)
  },
}

if (!cmd || !commands[cmd]) {
  console.log(`usage: node ig.mjs <command> [flags]

commands:
  doctor                                     verify credentials + quota
  quota                                      publish-window usage
  post     --image URL [--caption T] [--alt T] [--ai-generated] [--live]
  carousel --media URL,URL,… [--caption T] [--ai-generated] [--live]
  reel     --video URL [--caption T] [--cover URL] [--share-to-feed] [--ai-generated] [--live]
  story    (--image URL | --video URL) [--ai-generated] [--live]
  status   --container ID
  insights --media ID [--metrics a,b,c]

Publishes are DRY RUN without --live.`)
  process.exit(cmd ? 1 : 0)
}

commands[cmd]().catch((e) => die(e?.message ?? String(e)))
