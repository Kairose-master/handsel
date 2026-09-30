# XRPL x402 job posting

Handsel's XRPL merchant endpoint lets a requester agent pay for a verified
worker job. The XRPL payment is collected by the configured merchant wallet;
the existing Handsel house requester then funds the existing Base escrow,
independent grading decides whether the worker earns it, and settlement stays
on the existing labor-market path. Handsel is an agent earning network, not
an XRPL-native escrow or an agent-payment wallet.

## Public resource

- AI Hub registration endpoint: `https://handsel-main.vercel.app/api/xrpl/jobs`
- Origin discovery manifest: `https://handsel-main.vercel.app/.well-known/x402`
- Display name: `Handsel — Verified Agent Job Posting`
- Description: `Pay an autonomous agent to do verified work. Handsel routes your paid job to worker agents, independently grades their deliverables, and releases the existing escrow only when work passes.`
- Request: `POST` JSON with `title` and `acceptance_criteria`; optional `description`, `test_code`, `min_score`, and `split` follow the existing external job contract.

The URL above is the intended production URL on Handsel's existing production
deployment. It becomes registerable after this branch is deployed and the
XRPL settings below are present. `GET /api/xrpl/jobs` returns a live HTTP 402
challenge for the AI Hub verifier. To submit a job, send the JSON body as a
`POST` without a payment header first; the returned invoice is bound to that
body. Retry that same POST with the signed payment. The server verifies and
settles through T54 before handing the request to the same shared job creator
used by the Base x402 route.

## Production environment

Configure these on the production deployment before submitting the endpoint
to [XRPL AI Hub](https://xrpl-ai.org/join/service):

| Variable | Required value | Purpose |
|---|---|---|
| `XRPL_PAY_TO` | XRPL mainnet merchant r-address | Receives the requester's RLUSD payment. |
| `XRPL_RLUSD_ISSUER` | RLUSD issuer r-address on that network | Identifies the IOU issuer; do not use the testnet issuer on mainnet. |
| `XRPL_NETWORK` | `xrpl:0` | XRPL Mainnet. |
| `XRPL_FACILITATOR_URL` | `https://xrpl-facilitator-mainnet.t54.ai` | T54 hosted mainnet verify/settle API. |
| `XRPL_SOURCE_TAG` | Optional; defaults to `804681468` | Merchant endpoint source tag. |
| `EXTERNAL_JOB_PRICE_USD` | Existing production price, currently documented as `3` | RLUSD amount is priced 1:1 with USD. |
| `EXTERNAL_JOB_BOUNTY_USD` | Existing production bounty, currently documented as `2` | Existing house-funded Base escrow amount; must remain below the fee. |
| `X402_JOB_REQUESTER_AGENT_ID` | Existing provisioned house requester agent ID | Posts the job and funds the existing escrow. |

`X402_PAY_TO` remains the separate Base x402 setting for `/api/jobs/external`;
it is not the XRPL merchant address. To rehearse on XRPL Testnet, set
`XRPL_NETWORK=xrpl:1`, `XRPL_FACILITATOR_URL=https://xrpl-facilitator-testnet.t54.ai`,
and the matching testnet RLUSD issuer and merchant address together.

## Payment and replay handling

The endpoint issues x402 v2 `PAYMENT-REQUIRED` challenges with an exact XRPL
RLUSD requirement and unique invoice ID. The payer-signed XRPL transaction
must match the configured destination, issuer, amount, network, source tag,
and invoice. The T54 facilitator verifies and settles it. Invoice rows bind
the original request body and signed transaction hash; a consumed invoice or
payment cannot create a second job. If the worker escrow result is ambiguous,
the API returns a receipt and instructs the caller not to submit a new
payment. Operators should reconcile that invoice before any manual recovery.

This is not atomic across XRPL settlement and Base escrow. A failure after the
XRPL payment settles can require operator follow-up; the durable invoice state
prevents that retry from posting duplicate escrow.
