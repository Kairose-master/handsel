import Link from 'next/link'

export const metadata = {
  title: 'Chrome Extension Privacy — Handsel',
  description: 'How Handsel Spend Controls for Chrome accesses, uses, stores, and protects account and spending data.',
}

const sections = [
  {
    title: 'What the extension does',
    body: 'Handsel Spend Controls for Chrome is a companion dashboard. It shows the signed-in account’s agents, spending limits, and recent spend records, and lets the account owner update an agent’s spending limits. Limit changes apply to all supported outgoing spend paths for that agent.',
  },
  {
    title: 'Data accessed and transmitted',
    body: 'After you connect an account, the extension receives your account email, owned agent names and identifiers, spending envelopes, rolling 24-hour spend totals, and recent spend ledger entries from the Handsel deployment you selected. It sends limit changes you submit back to that deployment. Requests use HTTPS for production deployments. Local development can use localhost when selected by the user.',
  },
  {
    title: 'Local storage and authentication',
    body: 'The extension stores its OAuth access token and selected deployment in Chrome extension local storage so it can stay connected between popup sessions. The token is scoped to the extension dashboard API, expires after 90 days, and is revoked server-side when you choose Disconnect. To revoke it immediately, choose Disconnect before uninstalling the extension.',
  },
  {
    title: 'Data not collected',
    body: 'The extension does not read active tabs, page content, browsing history, cookies, or website requests. It does not initiate payments, access wallet private keys, or send data to advertising or analytics services.',
  },
  {
    title: 'Use, sharing, and retention',
    body: 'Data is used only to provide the spending dashboard and save limits you request. The extension does not sell data or use it for advertising. Account and spend records are processed by the Handsel deployment you select under that service’s data handling and retention practices. Disconnect revokes the extension credential; it does not delete your Handsel account or its records.',
  },
  {
    title: 'Contact',
    body: 'For privacy questions or requests related to extension access, contact the Handsel operator through the project’s public GitHub repository.',
  },
]

export default function ExtensionPrivacyPage() {
  return (
    <main className="min-h-svh bg-background px-6 py-12 text-foreground">
      <article className="mx-auto max-w-2xl space-y-8">
        <header className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">Handsel Spend Controls for Chrome</p>
          <h1 className="text-3xl font-semibold tracking-tight">Privacy policy</h1>
          <p className="text-sm text-muted-foreground">Last updated September 28, 2026</p>
        </header>
        {sections.map((section) => (
          <section key={section.title} className="space-y-2">
            <h2 className="text-lg font-semibold">{section.title}</h2>
            <p className="text-sm leading-7 text-muted-foreground">{section.body}</p>
          </section>
        ))}
        <footer className="border-t border-border pt-5 text-sm text-muted-foreground">
          <Link href="/" className="text-primary hover:underline">Back to Handsel</Link>
        </footer>
      </article>
    </main>
  )
}
