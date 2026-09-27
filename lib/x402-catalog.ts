/**
 * What Handsel sells over x402, described the way the Bazaar indexes it.
 *
 * Until 2026-09-27 each priced route carried a `description` and a
 * `mimeType` and nothing else, and the request body's shape lived only as
 * prose inside the description. The Bazaar (CDP's discovery layer) lists a
 * resource on its first settled call through the CDP facilitator, and ranks
 * it by whether an agent can call it without reading prose: an input schema
 * for the request, an output schema with a realistic example, a description
 * under 500 characters. This file is that metadata, in one place, edge-safe
 * (middleware imports it), and test-pinned so a route cannot be priced
 * without being describable.
 *
 * `discoverable: true` is the x402 flag that puts the resource in the
 * facilitator's discovery list. `resource` is left to the middleware, which
 * derives it from the request — but note the trap the community hit first:
 * behind a TLS-terminating proxy the derived URL can come out as `http://`
 * and the Bazaar drops it silently. Vercel forwards `x-forwarded-proto`, and
 * x402-next reads the request URL Next already normalized, so this
 * deployment is fine; a self-hosted one behind nginx must set the proxy
 * trust before this middleware runs.
 */
import { STOREFRONT_COMMISSIONS } from '@/lib/storefront-pricing'
import type { X402Network } from '@/lib/x402-network'

export const BAZAAR_DESCRIPTION_MAX = 500

export type X402Resource = {
  /** "<METHOD> <path pattern>" — the key x402-next's price map uses. */
  route: string
  price: string
  description: string
  mimeType: string
  inputSchema: {
    queryParams?: Record<string, string>
    bodyType?: 'json'
    bodyFields?: Record<string, unknown>
  }
  outputSchema: { example: Record<string, unknown> }
}

const reportExample = {
  agentId: 'ag_7f3k…',
  name: 'Researcher',
  creditScore: 612,
  creditRating: 'B',
  tasksCompleted: 41,
  tasksFailed: 3,
  gradedPassRate: 0.93,
  repayment: { loans: 2, defaults: 0 },
}

const indexExample = {
  type: 'HandselLaborIndex',
  methodology: 'https://github.com/Kairose-master/handsel/blob/main/docs/market-metrics.md',
  agents: { total: 132, active7d: 18 },
  jobs: { open: 7, settled30d: 46, medianBountyUsd: 1.14 },
  grading: { passRate30d: 0.71 },
}

export const X402_RESOURCES: readonly X402Resource[] = [
  {
    route: 'GET /api/agents/*/report',
    price: '$0.01',
    description:
      'Underwritten credit report for one Handsel agent: score and rating, graded-pass history on real escrowed jobs, and repayment record. Call before hiring or lending to an agent; the id is in the path.',
    mimeType: 'application/json',
    inputSchema: {},
    outputSchema: { example: reportExample },
  },
  {
    route: 'GET /api/market/index',
    price: '$0.01',
    description:
      'Handsel Labor Index: live agent supply, open job demand, settled-job counts, median clearing bounty and the independent-grading pass rate across the whole market. Call for a current read of the AI-agent labor market.',
    mimeType: 'application/json',
    inputSchema: {},
    outputSchema: { example: indexExample },
  },
  {
    route: 'POST /api/jobs/external',
    price: '$0.10',
    description:
      'Post a job to the Handsel Labor Market. The fee buys a house-escrowed bounty; an independent grader pays the worker only on pass. Body: title, acceptance_criteria (what pass means), optional description, test_code (Python tests = mechanical grading), min_score.',
    mimeType: 'application/json',
    inputSchema: {
      bodyType: 'json',
      bodyFields: {
        title: { type: 'string', required: true },
        acceptance_criteria: { type: 'string', required: true },
        description: { type: 'string' },
        test_code: { type: 'string', description: 'Python tests; makes grading mechanical' },
        min_score: { type: 'number' },
      },
    },
    outputSchema: { example: { status: 'posted', jobId: 143, bountyUsd: 25, proof: 'https://handsel-nu.vercel.app/proof/<id>' } },
  },
  ...STOREFRONT_COMMISSIONS.map<X402Resource>((c) => ({
    route: `POST /api/storefront/${c.templateId}/commission`,
    price: `$${c.priceUsd.toFixed(2)}`,
    description: `Commission the ${c.templateId} office — a pipeline of independently graded agents, paid only on pass. ${c.deliverable} Body: scope. Poll the returned token for the deliverable.`,
    mimeType: 'application/json',
    inputSchema: { bodyType: 'json', bodyFields: { scope: { type: 'string', required: true, description: 'What the office should work on' } } },
    outputSchema: { example: { status: 'commissioned', token: 'sf_9k2…', poll: `https://handsel-nu.vercel.app/api/storefront/${c.templateId}/status?token=sf_9k2…` } },
  })),
]

/** The x402-next `RoutesConfig` value for one resource. */
export function routeConfigFor(r: X402Resource, network: X402Network) {
  return {
    price: r.price,
    network,
    config: {
      description: r.description,
      mimeType: r.mimeType,
      discoverable: true,
      inputSchema: r.inputSchema,
      outputSchema: r.outputSchema,
    },
  }
}

/** The whole price map, keyed the way the middleware wants it. */
export function x402RoutesConfig(network: X402Network): Record<string, ReturnType<typeof routeConfigFor>> {
  return Object.fromEntries(X402_RESOURCES.map((r) => [r.route, routeConfigFor(r, network)]))
}

/** The `/.well-known/x402.json`-style public listing: what is for sale,
 *  where, for how much — the same facts the 402 challenge carries, readable
 *  without triggering one. */
export function x402Listing(origin: string, network: X402Network, payTo: string | null) {
  return {
    type: 'HandselX402Catalog',
    version: 1,
    network,
    payTo,
    facilitator: 'cdp',
    resources: X402_RESOURCES.map((r) => {
      const [method, path] = r.route.split(' ')
      return { method, url: `${origin}${path}`, price: r.price, description: r.description, mimeType: r.mimeType, inputSchema: r.inputSchema, outputSchema: r.outputSchema }
    }),
  }
}
