import { RepoCareWizardClient } from './wizard-client'

/**
 * Server wrapper for the Repo Care onboarding wizard — reads the checkout
 * URL server-side (`LEMONSQUEEZY_PILOT_CHECKOUT_URL` is not `NEXT_PUBLIC_`,
 * so a client component can't read it directly) and hands it down as a
 * prop. Mirrors `app/guest/page.tsx` + `PipelineDemo`.
 */
export default function RepoCareWizardPage() {
  const checkoutUrl = process.env.LEMONSQUEEZY_PILOT_CHECKOUT_URL || null
  return <RepoCareWizardClient checkoutUrl={checkoutUrl} />
}
