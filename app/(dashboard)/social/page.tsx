'use client'

/**
 * The Social Desk — the content queue's one surface. Same dashboard shell,
 * same job-card idiom as the rest of the product: a social publish is a job
 * with a lifecycle, not a separate universe.
 *
 * Everything here is a live query (no fake data): the queue rows, the
 * configured/not-configured banner, the per-status counts. The page can
 * DRAFT, SUBMIT and APPROVE; it cannot publish — the ops cycle does that,
 * and only for jobs a human approved (the fingerprint recorded at approval
 * is re-checked at publish time).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  approveSocial,
  createSocialDraft,
  deleteSocial,
  getSocialDesk,
  requeueSocial,
  submitSocialDraft,
} from '@/app/actions/social'
import type { SocialJob, SocialJobKind, SocialJobPayload } from '@/lib/social/social-job'

const STATUS_STYLES: Record<string, string> = {
  DRAFT: 'bg-muted text-muted-foreground',
  APPROVAL_REQUIRED: 'bg-warning/15 text-warning',
  READY: 'bg-primary/15 text-primary',
  SCHEDULED: 'bg-primary/15 text-primary',
  QUEUED: 'bg-primary/15 text-primary',
  PREPARING: 'bg-primary/15 text-primary',
  UPLOADING: 'bg-primary/15 text-primary',
  PROCESSING: 'bg-primary/15 text-primary',
  PUBLISHING: 'bg-primary/15 text-primary',
  PUBLISHED: 'bg-success/15 text-success',
  FAILED: 'bg-destructive/15 text-destructive',
  EXPIRED: 'bg-destructive/15 text-destructive',
  NEEDS_AUTH: 'bg-warning/15 text-warning',
}

const KIND_LABEL: Record<SocialJobKind, string> = {
  post: 'Post · 4:5 image',
  carousel: 'Carousel · 2–10 slides',
  reel: 'Reel · 9:16 MP4',
  story: 'Story · 9:16, 24h',
}

export default function SocialDeskPage() {
  const [jobs, setJobs] = useState<SocialJob[]>([])
  const [configured, setConfigured] = useState(true)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // create form
  const [showCreate, setShowCreate] = useState(false)
  const [kind, setKind] = useState<SocialJobKind>('post')
  const [mediaUrl, setMediaUrl] = useState('')
  const [carouselUrls, setCarouselUrls] = useState('')
  const [caption, setCaption] = useState('')
  const [altText, setAltText] = useState('')
  const [campaign, setCampaign] = useState('')
  const [scheduledAt, setScheduledAt] = useState('')
  const [shareToFeed, setShareToFeed] = useState(true)

  const refresh = useCallback(async () => {
    const data = await getSocialDesk()
    setJobs(data.jobs)
    setConfigured(data.configured)
  }, [])

  useEffect(() => {
    refresh()
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [refresh])

  // Poll so a job visibly walks QUEUED → … → PUBLISHED without clicking.
  useEffect(() => {
    pollRef.current = setInterval(() => refresh().catch(() => {}), 5000)
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [refresh])

  const run = async (key: string, fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(key)
    setError(null)
    try {
      const res = await fn()
      if (!res.ok) setError(res.error ?? 'Action failed')
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const create = async () => {
    const payload: SocialJobPayload = { caption: caption || undefined }
    if (kind === 'post') {
      payload.imageUrl = mediaUrl
      payload.altText = altText || undefined
    } else if (kind === 'reel') {
      payload.videoUrl = mediaUrl
      payload.shareToFeed = shareToFeed
    } else if (kind === 'story') {
      if (/\.(mp4|mov)(\?|$)/i.test(mediaUrl)) payload.videoUrl = mediaUrl
      else payload.imageUrl = mediaUrl
    } else {
      payload.items = carouselUrls
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((u) => (/\.(mp4|mov)(\?|$)/i.test(u) ? { videoUrl: u } : { imageUrl: u, altText: altText || undefined }))
    }
    await run('create', async () => {
      const res = await createSocialDraft({
        kind,
        payload,
        campaign: campaign || undefined,
        scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : undefined,
      })
      if (res.ok) {
        setShowCreate(false)
        setMediaUrl('')
        setCarouselUrls('')
        setCaption('')
        setAltText('')
      }
      return res
    })
  }

  if (loading) return <div className="p-8 text-sm text-muted-foreground">Loading the social desk…</div>

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-4 sm:p-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Social Desk</h1>
          <p className="text-sm text-muted-foreground">
            Instagram publishing queue — drafts wait for approval, approved posts publish on schedule.
          </p>
        </div>
        <button
          className="rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          onClick={() => setShowCreate((v) => !v)}
        >
          {showCreate ? 'Close' : 'New content'}
        </button>
      </div>

      {!configured && (
        <div className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
          Instagram is not configured on this deployment (INSTAGRAM_ACCESS_TOKEN / INSTAGRAM_ACCOUNT_ID unset). You can
          draft and approve; publishing will wait until the account is connected. See docs/social/instagram.md.
        </div>
      )}
      {error && <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm">{error}</div>}

      {showCreate && (
        <div className="space-y-3 rounded-xl border bg-card p-4">
          <div className="flex flex-wrap gap-2">
            {(Object.keys(KIND_LABEL) as SocialJobKind[]).map((k) => (
              <button
                key={k}
                onClick={() => setKind(k)}
                className={`rounded-lg border px-3 py-1.5 text-sm ${kind === k ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground'}`}
              >
                {KIND_LABEL[k]}
              </button>
            ))}
          </div>
          {kind === 'carousel' ? (
            <textarea
              className="w-full rounded-lg border bg-background p-2 text-sm"
              rows={4}
              placeholder={'One public https media URL per line (2–10)'}
              value={carouselUrls}
              onChange={(e) => setCarouselUrls(e.target.value)}
            />
          ) : (
            <input
              className="w-full rounded-lg border bg-background p-2 text-sm"
              placeholder={kind === 'reel' ? 'Public https MP4 URL (9:16)' : 'Public https media URL'}
              value={mediaUrl}
              onChange={(e) => setMediaUrl(e.target.value)}
            />
          )}
          {kind !== 'story' && (
            <textarea
              className="w-full rounded-lg border bg-background p-2 text-sm"
              rows={3}
              placeholder="Caption"
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
            />
          )}
          {(kind === 'post' || kind === 'carousel') && (
            <input
              className="w-full rounded-lg border bg-background p-2 text-sm"
              placeholder="Alt text (accessibility — images only)"
              value={altText}
              onChange={(e) => setAltText(e.target.value)}
            />
          )}
          {kind === 'reel' && (
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <input type="checkbox" checked={shareToFeed} onChange={(e) => setShareToFeed(e.target.checked)} />
              Also share to the feed grid
            </label>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <input
              className="rounded-lg border bg-background p-2 text-sm"
              placeholder="Campaign (optional)"
              value={campaign}
              onChange={(e) => setCampaign(e.target.value)}
            />
            <input
              type="datetime-local"
              className="rounded-lg border bg-background p-2 text-sm"
              value={scheduledAt}
              onChange={(e) => setScheduledAt(e.target.value)}
            />
            <button
              className="rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
              disabled={busy === 'create' || (kind === 'carousel' ? !carouselUrls.trim() : !mediaUrl.trim())}
              onClick={create}
            >
              {busy === 'create' ? 'Creating…' : 'Create draft'}
            </button>
            <span className="text-xs text-muted-foreground">Drafts never publish — approval is a separate, explicit step.</span>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {jobs.length === 0 && (
          <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
            Nothing queued. Content created here (or by an office agent) appears as a job card with its full lifecycle.
          </div>
        )}
        {jobs.map((job) => (
          <div key={job.id} className="rounded-xl border bg-card p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[job.status] ?? 'bg-muted'}`}>
                {job.status}
              </span>
              <span className="text-sm font-medium">{KIND_LABEL[job.kind]}</span>
              {job.campaign && <span className="text-xs text-muted-foreground">#{job.campaign}</span>}
              {job.scheduledAt && (
                <span className="text-xs text-muted-foreground">
                  scheduled {new Date(job.scheduledAt).toLocaleString()}
                </span>
              )}
              <span className="ml-auto text-xs text-muted-foreground">{new Date(job.createdAt).toLocaleString()}</span>
            </div>
            {job.payload.caption && (
              <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">{job.payload.caption}</p>
            )}
            {job.lastError && <p className="mt-2 text-xs text-destructive">{job.lastError}</p>}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {job.status === 'DRAFT' && (
                <button
                  className="rounded-lg border px-2.5 py-1 text-xs hover:bg-muted"
                  disabled={busy === job.id}
                  onClick={() => run(job.id, () => submitSocialDraft(job.id))}
                >
                  Submit for approval
                </button>
              )}
              {job.status === 'APPROVAL_REQUIRED' && (
                <button
                  className="rounded-lg bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground"
                  disabled={busy === job.id}
                  onClick={() => run(job.id, () => approveSocial(job.id))}
                >
                  Approve for publish
                </button>
              )}
              {(job.status === 'FAILED' || job.status === 'EXPIRED' || job.status === 'NEEDS_AUTH') && (
                <button
                  className="rounded-lg border px-2.5 py-1 text-xs hover:bg-muted"
                  disabled={busy === job.id}
                  onClick={() => run(job.id, () => requeueSocial(job.id))}
                >
                  Retry
                </button>
              )}
              {job.status === 'PUBLISHED' && job.permalink && (
                <a className="text-xs text-primary underline" href={job.permalink} target="_blank" rel="noreferrer">
                  View on Instagram
                </a>
              )}
              {job.status !== 'PUBLISHED' && !['PREPARING', 'UPLOADING', 'PROCESSING', 'PUBLISHING'].includes(job.status) && (
                <button
                  className="rounded-lg border px-2.5 py-1 text-xs text-destructive hover:bg-destructive/10"
                  disabled={busy === job.id}
                  onClick={() => run(job.id, () => deleteSocial(job.id))}
                >
                  Delete
                </button>
              )}
              {job.remoteMediaId && <span className="text-xs text-muted-foreground">media {job.remoteMediaId}</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
