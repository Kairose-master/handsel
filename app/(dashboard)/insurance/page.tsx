'use client'

import Link from 'next/link'
import { ArrowRight, ShieldCheck } from 'lucide-react'
import { useI18n } from '@/lib/i18n'

/**
 * Not a real product yet — the previous version of this page showed a
 * fabricated capital pool, underwriter count, and coverage numbers, which
 * violates this project's own "no fabricated numbers" principle
 * (`insurancePolicy` exists in the schema, but nothing reads or writes it
 * from real logic; see Claude.md's known-gaps list). Honest placeholder
 * instead: what this will become once built, and why it isn't yet —
 * pricing coverage needs real portfolio risk data, which /risk now
 * actually computes.
 */
export default function InsurancePage() {
  const { t } = useI18n()
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">{t('ins.title')}</h1>
        <p className="text-muted-foreground">{t('ins.subtitle')}</p>
      </div>

      <div className="glass-card rounded-lg border border-border p-6">
        <p className="flex items-center gap-2 font-semibold">
          <ShieldCheck className="size-4 text-muted-foreground" /> {t('ins.notBuiltTitle')}
        </p>
        <p className="mt-2 text-sm text-muted-foreground">{t('ins.notBuiltBody')}</p>
        <Link
          href="/risk"
          className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
        >
          {t('ins.viewRisk')} <ArrowRight className="size-3.5" />
        </Link>
      </div>

      <div className="glass-card rounded-lg border border-border p-6">
        <h3 className="font-bold text-lg mb-3">{t('ins.plannedTitle')}</h3>
        <div className="space-y-2">
          {[
            'ins.productDefaultCoverage',
            'ins.productOperationalRisk',
            'ins.productLiquidationProtection',
            'ins.productSmartContractInsurance',
          ].map((product) => (
            <div key={product} className="rounded bg-secondary/50 p-3 text-sm font-medium text-muted-foreground">
              {t(product)}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
