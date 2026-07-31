'use client'

import { ShieldCheck } from 'lucide-react'
import { useI18n } from '@/lib/i18n'

/**
 * The financial-product footer: environment disclosure, license, and the
 * accountability links (source, security policy, docs). Every credible
 * financial interface labels its environment and its terms — the absence
 * of this strip is one of the things that made the app read as a demo.
 */
/**
 * `realMoney` is tri-state on purpose: `false` = testnet (say the balances are
 * worthless), `true` = mainnet (say they are not), `null`/`undefined` = the
 * caller does not know — and a disclosure written from ignorance is a guess,
 * so nothing renders. This line used to be a hardcoded testnet notice, which
 * turned false the day the deployment moved to Base mainnet.
 */
export function SiteFooter({ realMoney = null }: { realMoney?: boolean | null }) {
  const { t } = useI18n()
  return (
    <footer className="mt-12 border-t border-border pb-6 pt-6 text-xs text-muted-foreground">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {realMoney !== null && (
          <p className="flex items-center gap-1.5">
            <ShieldCheck className="size-3.5" />
            {realMoney ? t('footer.mainnetNotice') : t('footer.testnetNotice')}
          </p>
        )}
        <nav className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <a
            className="hover:text-foreground hover:underline"
            href="https://github.com/Kairose-master/handsel"
            target="_blank"
            rel="noopener noreferrer"
          >
            {t('footer.source')}
          </a>
          <a
            className="hover:text-foreground hover:underline"
            href="https://github.com/Kairose-master/handsel/blob/main/SECURITY.md"
            target="_blank"
            rel="noopener noreferrer"
          >
            {t('footer.securityPolicy')}
          </a>
          <a
            className="hover:text-foreground hover:underline"
            href="https://github.com/Kairose-master/handsel/blob/main/docs/pitch-deck.md"
            target="_blank"
            rel="noopener noreferrer"
          >
            {t('footer.about')}
          </a>
          <a
            className="hover:text-foreground hover:underline"
            href="https://github.com/Kairose-master/handsel/issues"
            target="_blank"
            rel="noopener noreferrer"
          >
            {t('footer.knownGaps')}
          </a>
          <a className="hover:text-foreground hover:underline" href="/llms.txt" target="_blank" rel="noopener noreferrer">
            {t('footer.forAgents')}
          </a>
        </nav>
      </div>
      <p className="mt-3 leading-relaxed">
        {t('footer.tagline')}
      </p>
    </footer>
  )
}
