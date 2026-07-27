/**
 * The doctor — today's manual outage diagnosis, automated.
 *
 * Every check in this file exists because a real onboarding hit the wall it
 * now detects, and each wall cost a human round-trip to GitHub settings to
 * see: the App had the Issues *permission* but not the Issues *event
 * subscription* (webhooks silently never sent), the webhook secret was
 * present but deliveries were failing, a worker agent had no key. The App
 * JWT can read all of it (`GET /app`, `GET /app/hook/deliveries`), so a
 * page can say in one glance what took an afternoon of log archaeology.
 *
 * Checks return pass/warn/fail + a sentence a non-expert can act on. No
 * check ever fabricates: when the App isn't configured the downstream
 * checks say so instead of guessing.
 */
import { getGithubAppConfig, getGithubWebhookSecret, appJwt } from '@/lib/github-app'

export type DoctorStatus = 'pass' | 'warn' | 'fail'
export type DoctorCheck = { id: string; label: string; status: DoctorStatus; detail: string }

const GITHUB_API = 'https://api.github.com'

/** Events the webhook handler actually consumes (app/api/github/webhook).
 *  `issues` powers the label-to-bounty bot; the PR/check pair powers grading
 *  and settlement. An App missing one of these fails silently — GitHub just
 *  never sends the event — which is exactly why this check exists. */
export const REQUIRED_APP_EVENTS = ['issues', 'pull_request', 'check_suite'] as const

async function appApi<T>(path: string, jwt: string): Promise<T> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'handsel-doctor',
    },
  })
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`)
  return (await res.json()) as T
}

type AppMeta = { name?: string; slug?: string; events?: string[]; permissions?: Record<string, string> }
type Delivery = { event: string; action: string | null; status_code: number; delivered_at: string; redelivery: boolean }

/** Pure so it can be unit-tested without GitHub: classify the App's event
 *  subscriptions against what the webhook handler consumes. */
export function classifyAppEvents(subscribed: string[] | undefined): DoctorCheck {
  const have = new Set(subscribed ?? [])
  const missing = REQUIRED_APP_EVENTS.filter((e) => !have.has(e))
  if (missing.length === 0) {
    return {
      id: 'app-events',
      label: 'Webhook event subscriptions',
      status: 'pass',
      detail: `Subscribed to ${REQUIRED_APP_EVENTS.join(', ')}.`,
    }
  }
  return {
    id: 'app-events',
    label: 'Webhook event subscriptions',
    status: 'fail',
    detail:
      `Missing: ${missing.join(', ')}. GitHub will silently never deliver these — ` +
      `check them under the App's Permissions & events → "Subscribe to events" and save. ` +
      `(Event subscriptions need no installation re-approval.)`,
  }
}

/** Pure: summarize recent deliveries into a health verdict. Zero deliveries
 *  is a warn, not a fail — a quiet repo is not a broken pipeline. */
export function classifyDeliveries(deliveries: Delivery[]): DoctorCheck {
  if (deliveries.length === 0) {
    return {
      id: 'app-deliveries',
      label: 'Recent webhook deliveries',
      status: 'warn',
      detail: 'No deliveries recorded yet — either no activity, or events are not subscribed.',
    }
  }
  const failures = deliveries.filter((d) => d.status_code >= 300)
  const byEvent = new Map<string, number>()
  for (const d of deliveries) byEvent.set(d.event, (byEvent.get(d.event) ?? 0) + 1)
  const eventsSeen = [...byEvent.entries()].map(([e, n]) => `${e}×${n}`).join(', ')
  if (failures.length > 0) {
    return {
      id: 'app-deliveries',
      label: 'Recent webhook deliveries',
      status: 'fail',
      detail: `${failures.length}/${deliveries.length} recent deliveries failed (latest HTTP ${failures[0].status_code} on ${failures[0].event}). Seen: ${eventsSeen}.`,
    }
  }
  return {
    id: 'app-deliveries',
    label: 'Recent webhook deliveries',
    status: 'pass',
    detail: `${deliveries.length} recent deliveries, all 2xx. Seen: ${eventsSeen}.`,
  }
}

/** Platform-level checks. Never throws — a doctor that crashes on the
 *  disease it diagnoses is useless, so every probe degrades to a check row. */
export async function githubAppChecks(): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = []

  const config = await getGithubAppConfig().catch(() => null)
  if (!config) {
    checks.push({
      id: 'app-config',
      label: 'GitHub App credentials',
      status: 'fail',
      detail: 'GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY are not configured — repo jobs and the label bot are off.',
    })
    return checks
  }
  checks.push({ id: 'app-config', label: 'GitHub App credentials', status: 'pass', detail: 'App id + private key present.' })

  const secret = await getGithubWebhookSecret().catch(() => null)
  checks.push(
    secret
      ? { id: 'webhook-secret', label: 'Webhook secret', status: 'pass', detail: 'Configured; deliveries are HMAC-verified.' }
      : {
          id: 'webhook-secret',
          label: 'Webhook secret',
          status: 'fail',
          detail: 'Not configured — every delivery is rejected with 503. Set GITHUB_WEBHOOK_SECRET to the value in the App settings.',
        },
  )

  const jwt = appJwt(config.appId, config.privateKey)
  try {
    const meta = await appApi<AppMeta>('/app', jwt)
    checks.push(classifyAppEvents(meta.events))
    const issuesPerm = meta.permissions?.issues
    checks.push(
      issuesPerm === 'write'
        ? { id: 'issues-permission', label: 'Issues permission', status: 'pass', detail: 'Read & write — the bot can comment on issues.' }
        : {
            id: 'issues-permission',
            label: 'Issues permission',
            status: issuesPerm ? 'warn' : 'fail',
            detail: issuesPerm
              ? `Currently "${issuesPerm}" — the label bot needs Read & write to comment. Permission changes require installation re-approval.`
              : 'Not granted — the label-to-bounty bot cannot see or comment on issues.',
          },
    )
  } catch (e) {
    checks.push({
      id: 'app-events',
      label: 'Webhook event subscriptions',
      status: 'fail',
      detail: `Could not read the App's configuration (${e instanceof Error ? e.message : e}). The App id/key pair may be wrong.`,
    })
  }

  try {
    const deliveries = await appApi<Delivery[]>('/app/hook/deliveries?per_page=30', jwt)
    checks.push(classifyDeliveries(deliveries))
  } catch (e) {
    checks.push({
      id: 'app-deliveries',
      label: 'Recent webhook deliveries',
      status: 'warn',
      detail: `Could not list deliveries (${e instanceof Error ? e.message : e}).`,
    })
  }

  return checks
}

/** Email infra: optional, but when configured the payout + loan-lifecycle
 *  notices flow; when not, the check names the two env vars. */
export function emailCheck(): DoctorCheck {
  const configured = Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM)
  return configured
    ? { id: 'email', label: 'Email notifications', status: 'pass', detail: 'Resend configured — payout and loan-lifecycle emails active.' }
    : {
        id: 'email',
        label: 'Email notifications',
        status: 'warn',
        detail: 'Not configured (optional). Set RESEND_API_KEY and EMAIL_FROM to enable payout + loan due/overdue/default emails.',
      }
}

/** House-economy checks: is the wallet that funds faucet jobs and top-ups
 *  actually solvent? Only meaningful when a house agent is configured. */
export async function houseChecks(): Promise<DoctorCheck[]> {
  const houseAgentId = process.env.X402_JOB_REQUESTER_AGENT_ID
  if (!houseAgentId) {
    return [
      {
        id: 'house-wallet',
        label: 'House wallet',
        status: 'warn',
        detail: 'X402_JOB_REQUESTER_AGENT_ID not set — no faucet jobs or automatic top-ups (optional feature).',
      },
    ]
  }
  try {
    const { houseBalanceUsd } = await import('@/lib/house-funding')
    const { address, balanceUsd } = await houseBalanceUsd(houseAgentId)
    if (!address || balanceUsd === null) {
      return [{ id: 'house-wallet', label: 'House wallet', status: 'warn', detail: 'House agent has no readable wallet.' }]
    }
    return [
      {
        id: 'house-wallet',
        label: 'House wallet',
        status: balanceUsd >= 20 ? 'pass' : 'warn',
        detail: `$${balanceUsd.toFixed(2)} test USDC${balanceUsd < 20 ? ' — low; the cron tops up below $50' : ''}.`,
      },
    ]
  } catch (e) {
    return [{ id: 'house-wallet', label: 'House wallet', status: 'warn', detail: `Balance unreadable (${e instanceof Error ? e.message : e}).` }]
  }
}
