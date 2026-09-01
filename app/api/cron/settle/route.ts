import { runOpsCycle } from '@/lib/ops-cycle'

export const maxDuration = 300 // settlement = several on-chain txs, LLM verify calls

/**
 * GET /api/cron/settle — the platform's background settlement heartbeat.
 *
 * Historically every verification/finalization tick piggybacked on a human
 * polling a page ("no-cron" design). That works until the human closes the
 * tab: Submitted jobs then sit ungraded and the UI falls back to manual
 * approve/dispute buttons. This endpoint is the scheduler-callable version:
 *
 *  - Vercel Cron (vercel.json) — the real scheduler, every 5 minutes. Vercel
 *    signs the request with CRON_SECRET itself, so nothing has to be stored
 *    outside the project. This deployment is on Pro; a Hobby project is
 *    capped at daily and needs the Action below instead.
 *  - GitHub Actions (.github/workflows/settle-heartbeat.yml) — free, but
 *    measured at 80–100 min against a requested 5, so it is a floor on
 *    freshness, not a guarantee. A fallback, not the plan.
 *
 * Frequency is not cosmetic. Traffic drives only the FAST subset, and the two
 * steps that move an open plan forward — `fleetTick` (mining) and
 * `delegations` (waves, peer review, synthesis) — are not in it. They run
 * here or nowhere, so a daily schedule reads from outside as a market where
 * no worker ever claims anything.
 *
 * The sweeps themselves live in lib/ops-cycle.ts, because ordinary traffic
 * drives the latency-critical subset of the same list (see
 * maybeRunTrafficTick) — one definition, no drift between "what the cron
 * runs" and "what a page load runs".
 *
 * Auth: `Authorization: Bearer <CRON_SECRET>`. A secret in the query string is
 * refused, including here — Vercel Cron and GitHub Actions both set headers,
 * so the scheduler that "can't set headers" does not exist in this deployment.
 * With CRON_SECRET unset the endpoint refuses to run — never deploy an open
 * settlement trigger.
 */
export async function GET(request: Request) {
  // GET, and it does move money — but this one has to stay GET because it is
  // the Vercel Cron entrypoint and cron issues GET. It is safe to fire twice:
  // every step inside runOpsCycle now takes a cross-instance lease, which is
  // exactly the property that makes an accidental extra call a no-op rather
  // than a duplicate spend. `mutating: false` here means "GET is expected",
  // not "nothing happens".
  const { requireOperator } = await import('@/lib/admin-route')
  const auth = requireOperator(request, { mutating: false })
  if (!auth.ok) return auth.response
  // The deployment's own PUBLIC origin — not this request's host. A Vercel
  // Cron invocation can arrive on a deployment-specific host, and on a
  // project with deployment protection every URL later built from that host
  // (runtime callbacks, the execute handoff) answers with the auth wall's
  // 401 instead of our route. That is why cron-context dispatches died with
  // no callback while identical dispatches riding visitor traffic — whose
  // requests carry the public host — completed (2026-08-31, measured).
  const { origin } = await import('@/lib/origin')
  const report = await runOpsCycle(origin())

  return Response.json({ ok: true, ...report })
}
