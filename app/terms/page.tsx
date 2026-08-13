import { redirect } from 'next/navigation'

/** The path outside auditors guess first (issue #5 found it 404ing). One
 *  document, several doors: the content lives at /participation. */
export default function TermsPage() {
  redirect('/participation')
}
