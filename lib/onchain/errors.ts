/**
 * Human-readable explanations for on-chain failures.
 *
 * A reverted ERC-4337 UserOperation surfaces as ~2KB of calldata, gas fields
 * and an ABI-encoded `Error(string)` blob. The one useful byte-range in there
 * — the revert reason — is the last thing anyone can find. An operator seeing
 * that dump reasonably concludes the infrastructure is broken and starts
 * looking for a billing page, when the actual message is usually one short
 * sentence ("the wallet is empty").
 *
 * Pure and unit-tested: give it the error, get the sentence.
 */
import { LABOR_MARKET_V2_ABI } from './labor-v2-artifact'
import { decodeCustomError, extractRevertData } from './custom-errors'

/** Decode a hex-encoded `Error(string)` payload if one is embedded anywhere
 *  in the message. Returns null when there is nothing decodable. */
export function decodeRevertReason(message: string): string | null {
  const match = message.match(/0x08c379a0([0-9a-fA-F]{128,})/)
  if (!match) return null
  try {
    const body = Buffer.from(match[1], 'hex')
    const length = Number(BigInt('0x' + body.subarray(32, 64).toString('hex')))
    if (!Number.isFinite(length) || length <= 0 || length > body.length - 64) return null
    const text = body.subarray(64, 64 + length).toString('utf8')
    return /^[\x20-\x7e]+$/.test(text) ? text : null
  } catch {
    return null
  }
}

/** Maps a known revert reason to what the operator should actually do. */
const REVERT_GUIDE: Array<{ match: RegExp; explain: string }> = [
  {
    match: /USDC: balance/,
    explain:
      'the requester wallet does not hold enough test USDC to escrow this bounty. ' +
      'Testnet MockUSDC is free to mint — top the wallet up (Admin → Board curation → Top up house requester, ' +
      'or the mint_test_usdc MCP tool). Nothing here is a paid plan: gas is already sponsored by the paymaster.',
  },
  {
    match: /USDC: allowance/,
    explain: 'the escrow approval did not land before the transfer — retry the action.',
  },
  { match: /SelfWork/, explain: 'an agent cannot work a job its own account posted.' },
  { match: /NotRequester/, explain: 'only the agent that posted the job can approve or cancel it.' },
  { match: /NotWorker/, explain: 'only the agent that accepted the job can submit work for it.' },
  { match: /WrongStatus|InvalidStatus/, explain: 'the job already moved to another status — reload and check its current state.' },
  { match: /MinScore|ScoreTooLow/, explain: "the worker's credit score is below the minimum this job requires." },
]

/**
 * One sentence an operator can act on. Falls back to a trimmed version of the
 * original message (never the raw multi-KB UserOperation dump).
 */
/**
 * Every ABI whose errors could plausibly reach here, tried in turn.
 *
 * One thrown error could have come from the market, the vault or the escrow, and
 * `decodeCustomError` returns null rather than guessing — so a payload this ABI
 * does not recognise falls through to the next instead of being named with the
 * wrong contract's vocabulary.
 *
 * Statically imported. A lazy `require` here would have kept this module free of
 * the ~40KB generated ABI, and it does not work under ESM — the first run threw
 * `Cannot find module './custom-errors'` from inside the very function whose job
 * is to stop errors being unreadable. The ABI is already in the bundle because
 * labor-v2.ts imports it, so the saving was imaginary.
 */
function explainAgainstKnownAbis(error: unknown): { name: string; message: string } | null {
  const data = extractRevertData(error)
  if (!data) return null
  for (const abi of [LABOR_MARKET_V2_ABI]) {
    try {
      const decoded = decodeCustomError(data, abi as never)
      // `Error(string)` and `Panic(uint256)` are Solidity BUILTINS, and viem
      // decodes them against any ABI. So a plain `require("USDC: balance...")`
      // came back as name `Error` and fell into the generic branch, which
      // reported "the contract rejected the call with Error" and threw the
      // string away — a regression this ordering caused on its first run, caught
      // by the test that already covered the empty-wallet case.
      //
      // They are not custom errors and `decodeRevertReason` + REVERT_GUIDE below
      // already turn them into good sentences, so hand them straight over.
      if (decoded && decoded.name !== 'Error' && decoded.name !== 'Panic') return decoded
    } catch {
      // Decoding must never itself be the reason a message is lost.
    }
  }
  return null
}

export function explainOnchainError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)

  // Custom errors FIRST, because LaborMarketV2 raises nothing else and the
  // decoder below cannot see them. All 23 of its failure modes are a four-byte
  // selector plus ABI-encoded args, so `Error(string)` decoding finds nothing and
  // viem's own fallback — "Execution reverted for an unknown reason" — is what an
  // operator got for every one of them. The reason was in the response the whole
  // time; three of the errors even carry the numbers that explain themselves.
  const custom = explainAgainstKnownAbis(error)
  if (custom) return `On-chain call reverted (${custom.name}) — ${custom.message}`

  const reason = decodeRevertReason(raw) ?? raw.match(/reverted with reason:?\s*([A-Za-z][^.\n]{0,60})/)?.[1]?.trim()
  if (reason) {
    const guide = REVERT_GUIDE.find((g) => g.match.test(reason))
    if (guide) return `On-chain call reverted (${reason}) — ${guide.explain}`
    return `On-chain call reverted: ${reason}`
  }

  if (/429|rate limit|Too Many Requests|compute units/i.test(raw)) {
    return 'The RPC provider is rate-limiting us right now — retry in a moment.'
  }
  if (/paymaster/i.test(raw) && /reject|denied|not sponsored/i.test(raw)) {
    return 'The gas sponsor (paymaster) declined this operation — check the ZeroDev project policy.'
  }
  if (/AA2[0-9]|AA1[0-9]|AA3[0-9]/.test(raw)) {
    return `Account-abstraction pre-check failed: ${raw.match(/AA\d\d[^.\n]{0,80}/)?.[0] ?? raw.slice(0, 120)}`
  }

  // Unknown: keep it short. The full error is already in the server logs.
  const firstLine = raw.split('\n')[0]
  return firstLine.length > 220 ? `${firstLine.slice(0, 220)}…` : firstLine
}
