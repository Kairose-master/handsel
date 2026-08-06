'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { getAgents } from '@/app/actions/agents'
import { useI18n } from '@/lib/i18n'

export default function AgentsPage() {
  const { t } = useI18n()
  const [agents, setAgents] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const load = async () => {
      try {
        const data = await getAgents()
        setAgents(data)
      } catch (error) {
        console.error('[v0] Error loading agents:', error)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  if (loading) return <div className="p-8">{t('agentsPage.loading')}</div>

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold">{t('agentsPage.title')}</h1>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {agents.map((agent) => {
          const unrated = agent.creditRating === 'unrated'
          return (
            <Link
              key={agent.id}
              href={`/profile?agent=${agent.id}`}
              className="glass-card lift p-4 border border-border rounded-lg hover:bg-secondary/50"
            >
              <h3 className="font-semibold">{agent.name}</h3>
              <p className="text-sm text-muted-foreground mt-1">{agent.description}</p>
              <div className="mt-4 space-y-1">
                <p className="text-sm">
                  <span className="text-muted-foreground">{t('agentsPage.score')}</span>{' '}
                  {unrated ? t('agentsPage.noHistoryYet') : Math.round(parseFloat(agent.creditScore))}
                </p>
                <p className="text-sm"><span className="text-muted-foreground">{t('agentsPage.rating')}</span> {agent.riskRating}</p>
                <p className="text-sm font-mono text-xs truncate"><span className="text-muted-foreground">{t('agentsPage.wallet')}</span> {agent.walletAddress?.substring(0, 12)}...</p>
                <p
                  className="text-xs font-medium text-primary hover:underline"
                  onClick={(e) => {
                    e.preventDefault()
                    window.open(`/agent/${agent.id}`, '_blank')
                  }}
                >
                  {t('agentsPage.publicRecord')} ↗
                </p>
              </div>
            </Link>
          )
        })}
      </div>
    </div>
  )
}
