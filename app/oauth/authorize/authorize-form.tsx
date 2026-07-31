'use client'

import { useState } from 'react'
import { approveConnector } from '@/app/actions/oauth'

/** The consent form — credentials inline when there's no dashboard
 *  session, so the OAuth flow works from a fresh browser too. */
export function AuthorizeForm({
  clientName,
  sessionEmail,
  fields,
}: {
  clientName: string
  sessionEmail: string | null
  fields: Record<string, string>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [authMode, setAuthMode] = useState<'signin' | 'create'>('signin')

  const deny = () => {
    const target = new URL(fields.redirect_uri)
    target.searchParams.set('error', 'access_denied')
    if (fields.state) target.searchParams.set('state', fields.state)
    window.location.href = target.toString()
  }

  return (
    <form
      action={async (fd) => {
        setBusy(true)
        setError(null)
        const result = await approveConnector(fd)
        if (result?.error) {
          setError(result.error)
          setBusy(false)
        }
        // On success the server action redirects — nothing to do here.
      }}
      className="mt-4 space-y-4"
    >
      {Object.entries(fields).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}

      <p className="text-sm text-muted-foreground">
        <strong className="text-foreground">{clientName}</strong> wants to access your Handsel account. It will be able to:
      </p>
      <ul className="list-disc pl-5 text-sm text-muted-foreground">
        <li>see your agents, balances and credit scores</li>
        <li>plan delegations and browse open jobs</li>
        <li>
          {/* No chain qualifier: "(testnet)" was hardcoded here and turned
              into a false reassurance on mainnet — the one place it must not
              be wrong is a consent screen granting spend access. */}
          <strong className="text-foreground">post delegations that escrow real USDC</strong> from your agents — bounded by your
          spending caps
        </li>
      </ul>

      {sessionEmail ? (
        <>
          <p className="text-sm">
            Approving as <strong>{sessionEmail}</strong>
          </p>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={busy}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {busy ? 'Connecting…' : 'Approve'}
            </button>
            <button type="button" onClick={deny} className="rounded-md border border-border px-4 py-2 text-sm">
              Deny
            </button>
          </div>
        </>
      ) : (
        <div className="space-y-3">
          {/* Sign in vs. create — a tab pair; the clicked submit button carries
              the mode, so no hidden field is needed. */}
          <div className="flex rounded-md border border-border p-0.5 text-sm">
            {(['signin', 'create'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setAuthMode(m)}
                className={`flex-1 rounded px-3 py-1.5 font-medium transition ${
                  authMode === m ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-secondary'
                }`}
              >
                {m === 'signin' ? 'Sign in' : 'Create account'}
              </button>
            ))}
          </div>

          <input
            name="email"
            type="email"
            required
            placeholder="Email"
            className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm"
          />
          <input
            name="password"
            type="password"
            required
            minLength={authMode === 'create' ? 8 : undefined}
            placeholder={authMode === 'create' ? 'Choose a password (8+ chars)' : 'Password'}
            className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm"
          />

          {error && <p className="text-sm text-destructive">{error}</p>}

          <button
            type="submit"
            name="mode"
            value={authMode}
            disabled={busy}
            className="w-full rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {busy ? 'Connecting…' : authMode === 'create' ? 'Create account & approve' : 'Sign in & approve'}
          </button>

          <div className="flex items-center gap-3 text-[11px] uppercase tracking-wide text-muted-foreground">
            <span className="h-px flex-1 bg-border" /> or <span className="h-px flex-1 bg-border" />
          </div>

          {/* Guest: no fields — formNoValidate skips the required email/password. */}
          <button
            type="submit"
            name="mode"
            value="guest"
            formNoValidate
            disabled={busy}
            className="w-full rounded-md border border-border px-4 py-2.5 text-sm font-medium hover:bg-secondary disabled:opacity-50"
          >
            Continue as guest — no signup
          </button>
          <p className="text-[11px] text-muted-foreground">
            Guest gives you a throwaway account so you can start using the connector immediately. You can add an email
            and password later to keep it.
          </p>

          <button type="button" onClick={deny} className="w-full rounded-md px-4 py-2 text-sm text-muted-foreground hover:bg-secondary">
            Deny
          </button>
        </div>
      )}
    </form>
  )
}
