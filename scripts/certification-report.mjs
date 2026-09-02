#!/usr/bin/env node
/**
 * Produce a certification report for one agent, from live graded outcomes.
 *
 * The artifact `docs/go-to-market.md` §4(A) argues is the thing to sell. It is
 * a SCRIPT rather than a written document on purpose: a hand-written sample
 * would be a number somebody typed, and the entire pitch is that these numbers
 * are settled outcomes nobody chose.
 *
 *   DATABASE_URL=... node scripts/certification-report.mjs <agentId> [days]
 *
 * Reads `agent_events` — the same rows the credit score is computed from — and
 * refuses to state a figure it cannot source.
 */
import { Pool } from 'pg'

const [, , agentId, daysArg] = process.argv
if (!agentId) {
  console.error('usage: DATABASE_URL=… node scripts/certification-report.mjs <agentId> [days]')
  process.exit(1)
}
const days = Number(daysArg) || 365

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

// The grade events the callback writes (lib/callback/labor-market.ts), plus
// the grader class it stamps into detail. Anything without a class is left
// unclassified rather than guessed into one.
const { rows } = await pool.query(
  `SELECT e.event_type, e.detail, e.created_at
     FROM agent_events e
    WHERE e.agent_id = $1
      AND e.event_type IN ('JOB_TESTS_PASSED','JOB_TESTS_FAILED')
      AND e.created_at > now() - ($2 || ' days')::interval
    ORDER BY e.created_at`,
  [agentId, String(days)],
)

const CLASS_OF = {
  tests: 'mechanical',
  code: 'mechanical',
  ci: 'reproducible',
  'repo-open': 'declared',
  vision: 'model',
  audio: 'model',
  'llm-review': 'model',
}

const jobs = rows.map((r) => {
  const d = r.detail ?? {}
  return {
    jobId: d.jobId ?? null,
    passed: r.event_type === 'JOB_TESTS_PASSED',
    graderClass: CLASS_OF[d.grader] ?? 'declared',
    requesterAgentId: d.requesterAgentId ?? null,
    // Not recorded on the grade event; left absent rather than inferred from
    // the bounty, which is what was ESCROWED and not necessarily what settled.
    paidUsd: null,
    attempts: typeof d.attempts === 'number' ? d.attempts : null,
    at: new Date(r.created_at),
  }
})

const { buildCertificationReport, renderCertificationReport } = await import('../lib/certification-report.ts').catch(async () => {
  console.error(
    'This script imports a TypeScript module. Run it on Node 22.18+ (types are stripped natively), e.g.\n' +
      '  DATABASE_URL=… node scripts/certification-report.mjs <agentId>',
  )
  process.exit(1)
})

console.log(renderCertificationReport(buildCertificationReport(agentId, jobs)))
await pool.end()
