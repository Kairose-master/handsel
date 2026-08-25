'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import {
  Plug,
  CheckCircle2,
  Circle,
  Copy,
  Check,
  ExternalLink,
  ArrowRight,
  ShieldCheck,
} from 'lucide-react'
import { mcpGuideProgress } from '@/app/actions/office'
import { useI18n } from '@/lib/i18n'

const EXA_URL = 'https://mcp.exa.ai/mcp'

/** One value the user is meant to paste somewhere — a copy button next to
 *  the literal text, same interaction as the /guide page's connector URL. */
function CopyRow({ label, value, note }: { label: string; value: string; note?: string }) {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    await navigator.clipboard.writeText(value).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <div className="grid grid-cols-[110px_1fr] items-center gap-2 border-b border-border/60 px-3 py-2 text-sm last:border-0 sm:grid-cols-[140px_1fr]">
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
      <div className="flex min-w-0 items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded bg-secondary/60 px-2 py-1 font-mono text-xs">{value}</code>
        <button
          onClick={copy}
          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-secondary"
        >
          {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
          {copied ? t('mcpGuide.copied') : t('mcpGuide.copy')}
        </button>
      </div>
      {note && <p className="col-span-2 text-xs text-muted-foreground sm:col-span-1 sm:col-start-2">{note}</p>}
    </div>
  )
}

function RecipeCard({
  title,
  tag,
  tagTone,
  roleMap,
  children,
}: {
  title: string
  tag: string
  tagTone: 'instant' | 'selfhost'
  roleMap: string
  children: React.ReactNode
}) {
  return (
    <div className="glass-card rounded-xl border border-border p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-lg font-bold">{title}</h3>
        <span
          className={`shrink-0 rounded-full px-2.5 py-0.5 font-mono text-[10.5px] font-medium uppercase tracking-wide ${
            tagTone === 'instant' ? 'bg-success/15 text-success' : 'bg-primary/15 text-primary'
          }`}
        >
          {tag}
        </span>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">{roleMap}</p>
      {children}
    </div>
  )
}

export default function McpGuidePage() {
  const { t } = useI18n()
  const [progress, setProgress] = useState<{ hasMcpAgent: boolean } | null>(null)
  const [exaCopied, setExaCopied] = useState(false)

  useEffect(() => {
    let cancelled = false
    mcpGuideProgress()
      .then((p) => !cancelled && setProgress(p))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const fillExa = async () => {
    await navigator.clipboard.writeText(EXA_URL).catch(() => {})
    setExaCopied(true)
    setTimeout(() => setExaCopied(false), 1500)
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-3xl font-bold">
          <Plug className="size-7" /> {t('mcpGuide.title')}
        </h1>
        <p className="mt-1 text-muted-foreground">{t('mcpGuide.subtitle')}</p>
      </div>

      {/* Real, DB-backed progress — not a self-reported checkbox */}
      <div
        className={`glass-card flex items-center gap-2 rounded-lg border p-4 text-sm ${
          progress?.hasMcpAgent ? 'border-success/40 bg-success/5' : 'border-border'
        }`}
      >
        {progress?.hasMcpAgent ? (
          <CheckCircle2 className="size-5 shrink-0 text-success" />
        ) : (
          <Circle className="size-5 shrink-0 text-muted-foreground" />
        )}
        <span>{progress?.hasMcpAgent ? t('mcpGuide.progress.done') : t('mcpGuide.progress.todo')}</span>
        <Link
          href="/office"
          className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90"
        >
          {t('mcpGuide.officeCta')} <ArrowRight className="size-3.5" />
        </Link>
      </div>

      <div className="rounded-lg border border-border p-5">
        <p className="font-semibold">{t('mcpGuide.callout.title')}</p>
        <p className="mt-2 text-sm text-muted-foreground">{t('mcpGuide.callout.body1')}</p>
        <p className="mt-2 text-sm text-muted-foreground">{t('mcpGuide.callout.body2')}</p>
      </div>

      <h2 className="border-b border-border pb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {t('mcpGuide.section1')}
      </h2>
      <RecipeCard title={t('mcpGuide.exa.title')} tag={t('mcpGuide.exa.tag')} tagTone="instant" roleMap={t('mcpGuide.exa.roleMap')}>
        <p className="mt-3 text-sm text-muted-foreground">{t('mcpGuide.exa.body')}</p>
        <div className="mt-3 overflow-hidden rounded-lg border border-border">
          <CopyRow label={t('mcpGuide.kv.url')} value={EXA_URL} />
          <CopyRow label={t('mcpGuide.kv.tool')} value="web_search_exa" />
        </div>
        <button
          onClick={fillExa}
          className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          {exaCopied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />} {t('mcpGuide.exa.fill')}
        </button>
        <p className="mt-2 text-xs text-muted-foreground">{t('mcpGuide.exa.fillHint')}</p>
      </RecipeCard>

      <h2 className="border-b border-border pb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {t('mcpGuide.section2')}
      </h2>
      <div className="space-y-4">
        <RecipeCard
          title={t('mcpGuide.securities.title')}
          tag={t('mcpGuide.securities.tag')}
          tagTone="selfhost"
          roleMap={t('mcpGuide.securities.roleMap')}
        >
          <ol className="mt-3 space-y-2 text-sm text-muted-foreground">
            {['step1', 'step2', 'step3'].map((s, i) => (
              <li key={s} className="flex gap-2.5">
                <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-secondary text-xs font-bold text-foreground">
                  {i + 1}
                </span>
                <span>{t(`mcpGuide.securities.${s}`)}</span>
              </li>
            ))}
          </ol>
          <div className="mt-3 overflow-hidden rounded-lg border border-border">
            <CopyRow label={t('mcpGuide.kv.url')} value="https://<ngrok 주소>.ngrok-free.app/mcp" />
            <CopyRow label={t('mcpGuide.kv.auth')} value="Bearer <MCP_ACCESS_TOKEN>" />
            <CopyRow label="Chart Analyst" value="kis_price_lookup" />
            <CopyRow label="Rebalance Planner" value="kis_account_balance" />
          </div>
        </RecipeCard>

        <RecipeCard
          title={t('mcpGuide.obsidian.title')}
          tag={t('mcpGuide.obsidian.tag')}
          tagTone="selfhost"
          roleMap={t('mcpGuide.obsidian.roleMap')}
        >
          <ol className="mt-3 space-y-2 text-sm text-muted-foreground">
            {['step1', 'step2', 'step3'].map((s, i) => (
              <li key={s} className="flex gap-2.5">
                <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-secondary text-xs font-bold text-foreground">
                  {i + 1}
                </span>
                <span>{t(`mcpGuide.obsidian.${s}`)}</span>
              </li>
            ))}
          </ol>
          <div className="mt-3 overflow-hidden rounded-lg border border-border">
            <CopyRow label={t('mcpGuide.kv.url')} value="https://<ngrok 주소>.ngrok-free.app/mcp" />
            <CopyRow label={t('mcpGuide.kv.auth')} value="Bearer <MCP_ACCESS_TOKEN>" />
            <CopyRow
              label={t('mcpGuide.kv.tool')}
              value="obsidian_search"
              note="obsidian_read_note, obsidian_list_notes도 있음 — 에이전트 한 명당 도구 하나"
            />
          </div>
        </RecipeCard>
      </div>

      <h2 className="border-b border-border pb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {t('mcpGuide.section3')}
      </h2>
      <div className="rounded-lg border border-border p-5">
        <p className="text-sm text-muted-foreground">{t('mcpGuide.directory.body1')}</p>
        <p className="mt-2 text-sm text-muted-foreground">{t('mcpGuide.directory.body2')}</p>
        <Link
          href="/directory"
          className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-secondary"
        >
          {t('mcpGuide.directory.cta')} <ExternalLink className="size-3.5" />
        </Link>
      </div>

      <div className="rounded-lg border border-primary/30 bg-primary/5 p-5">
        <p className="flex items-center gap-2 font-semibold">
          <ShieldCheck className="size-4 text-primary" /> {t('mcpGuide.checklist.title')}
        </p>
        <ul className="mt-2 space-y-1.5 text-sm text-muted-foreground">
          <li>{t('mcpGuide.checklist.item1')}</li>
          <li>{t('mcpGuide.checklist.item2')}</li>
          <li>{t('mcpGuide.checklist.item3')}</li>
          <li>{t('mcpGuide.checklist.item4')}</li>
        </ul>
      </div>
    </div>
  )
}
