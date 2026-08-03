'use client'

import { AlertTriangle } from 'lucide-react'
import { useI18n } from '@/lib/i18n'

/**
 * The disclosure the footer was not making.
 *
 * The footer already says which environment this is — "balances are real USDC
 * with real monetary value" — and that is true and not enough. It states a
 * fact about the money and says nothing about the thing holding it: one
 * person's project, actively being probed, whose security work is ongoing.
 *
 * It went up the day strangers started arriving. Before that the only funds at
 * risk were the operator's, and an operator who reads their own repo needs no
 * banner. `docs/open-challenge.md` had already written the rule this follows —
 * *"inviting public attack against a system holding other people's assets puts
 * the blast radius outside the operator's control, and that is not a risk
 * anyone else agreed to take"* — and the same reasoning applies to letting
 * people deposit without saying it plainly first.
 *
 * Deliberately NOT dismissible. A risk disclosure that a user can dismiss is a
 * risk disclosure the next user does not see, and the cost of leaving it up is
 * a line of amber text.
 *
 * Renders only on `realMoney === true`. Tri-state, same as `SiteFooter`:
 * testnet needs no warning and "I don't know what chain this is" is not a
 * position from which to write one.
 */
export function RiskBanner({ realMoney = null }: { realMoney?: boolean | null }) {
  const { t } = useI18n()
  if (realMoney !== true) return null

  return (
    <div
      role="note"
      /* `text-foreground`, not `text-warning-foreground`: the latter is the
         colour for text ON a solid warning fill, and this is a 10% tint over
         the page. It renders near-white in light mode — an invisible warning. */
      className="border-b border-warning/30 bg-warning/10 px-4 py-2.5 text-xs leading-relaxed text-foreground"
    >
      <div className="mx-auto flex max-w-[1100px] items-start gap-2">
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
        <p>
          <span className="font-semibold">{t('disclosure.title')}</span> {t('disclosure.body')}{' '}
          <a
            className="underline underline-offset-2 hover:no-underline"
            href="https://github.com/Kairose-master/handsel/blob/main/docs/failure-modes.md"
            target="_blank"
            rel="noopener noreferrer"
          >
            {t('disclosure.failureLog')}
          </a>
          {' · '}
          <a
            className="underline underline-offset-2 hover:no-underline"
            href="https://github.com/Kairose-master/handsel/blob/main/docs/security-audit.md"
            target="_blank"
            rel="noopener noreferrer"
          >
            {t('disclosure.audit')}
          </a>
        </p>
      </div>
    </div>
  )
}
