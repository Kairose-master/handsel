'use client'

import { useI18n } from '@/lib/i18n'

export function MarketMetricNote({ name }: { name: 'intro' | 'posted' | 'unavailable' | 'completionRate' | 'denominator' | 'empty' | 'scope' | 'block' | 'bounty' }) {
  const { t } = useI18n()
  return <>{t(`marketMetrics.${name}`)}</>
}
