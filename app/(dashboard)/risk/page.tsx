'use client'

import { useEffect, useState } from 'react'
import { useI18n } from '@/lib/i18n'
import { getRiskAnalytics } from '@/app/actions/risk'
import { DecisionTableView } from '@/components/decision-table-view'
import { AUTO_RELEASE_TABLE, CREDIT_CEILING_TABLE } from '@/lib/decision-table'

type Analytics = Awaited<ReturnType<typeof getRiskAnalytics>>

export default function RiskPage() {
  const { t } = useI18n()
  const [data, setData] = useState<Analytics | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getRiskAnalytics()
      .then(setData)
      .finally(() => setLoading(false))
  }, [])

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">{t('risk.title')}</h1>
        <p className="text-muted-foreground">{t('risk.subtitle')}</p>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">{t('risk.loading')}</p>
      ) : !data?.hasAgents ? (
        <div className="glass-card rounded-lg border border-border p-6 text-sm text-muted-foreground">
          {t('risk.empty')}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="glass-card p-4 border border-border rounded-lg">
              <p className="text-xs text-muted-foreground">{t('risk.totalExposure')}</p>
              <p className="text-3xl font-bold mt-2">${Math.round(data.totalExposure).toLocaleString()}</p>
              <p className="text-xs text-muted-foreground mt-1">{t('risk.activeCreditLines')}: {data.activeCreditLines}</p>
            </div>
            <div className="glass-card p-4 border border-border rounded-lg">
              <p className="text-xs text-muted-foreground">{t('risk.aaaRated')}</p>
              <p className="text-3xl font-bold mt-2">
                {data.aaaShare === null ? '—' : `${Math.round(data.aaaShare * 100)}%`}
              </p>
              <p className="text-xs text-muted-foreground mt-1">{t('risk.portfolioComposition')}</p>
            </div>
            <div className="glass-card p-4 border border-border rounded-lg sm:col-span-2">
              <p className="text-xs text-muted-foreground">{t('risk.riskWeightedOutstanding')}</p>
              <p className="text-3xl font-bold mt-2">${Math.round(data.elevatedOrHighOutstanding).toLocaleString()}</p>
              <p className="text-xs text-muted-foreground mt-1">{t('risk.riskWeightedOutstandingSubtitle')}</p>
            </div>
          </div>

          <div className="glass-card border border-border rounded-lg p-6">
            <h3 className="font-bold text-lg mb-4">{t('risk.distributionTitle')}</h3>
            <p className="text-sm text-muted-foreground">{t('risk.distributionSubtitle')}</p>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mt-4">
              {data.ratingDistribution.map((r) => (
                <div key={r.band} className="p-3 bg-secondary/50 rounded text-center">
                  <p className="font-bold">{r.band === 'unrated' ? t('scores.unrated') : r.band}</p>
                  <p className="text-xs text-muted-foreground mt-1">{Math.round(r.share * 100)}% ({r.count})</p>
                </div>
              ))}
            </div>
          </div>

          <div className="glass-card border border-border rounded-lg p-6">
            <h3 className="font-bold text-lg mb-4">{t('risk.riskLevelTitle')}</h3>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
              {data.riskLevelDistribution.map((r) => (
                <div key={r.level} className="p-3 bg-secondary/50 rounded text-center">
                  <p className="font-bold">{r.level}</p>
                  <p className="text-xs text-muted-foreground mt-1">{Math.round(r.share * 100)}% ({r.count})</p>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {/* The trust gates as auditable decision tables — the same rules the
          settlement path evaluates, printed. */}
      <div className="space-y-4">
        <div>
          <h2 className="text-lg font-bold">Settlement decision policy</h2>
          <p className="text-sm text-muted-foreground">
            When escrow auto-releases vs. waits for a human, as decision tables. These aren’t a
            diagram of the logic — the settlement path evaluates the top table directly, so what you
            see is what runs.
          </p>
        </div>
        <DecisionTableView table={AUTO_RELEASE_TABLE} />
        <DecisionTableView table={CREDIT_CEILING_TABLE} />
      </div>
    </div>
  )
}
