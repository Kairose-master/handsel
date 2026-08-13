import { redirect } from 'next/navigation'

/** See app/terms/page.tsx — the privacy section lives in the single
 *  participation disclosure at /participation. */
export default function PrivacyPage() {
  redirect('/participation')
}
