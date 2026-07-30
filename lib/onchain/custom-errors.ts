/**
 * Decode a contract's CUSTOM errors, with their arguments.
 *
 * `lib/onchain/errors.ts` decodes `Error(string)` — selector `0x08c379a0`, the
 * old `require("...")` shape. LaborMarketV2 does not use it. Every one of its 23
 * failure modes is a custom error: a four-byte selector followed by ABI-encoded
 * arguments. To that decoder they are indistinguishable from noise, so every V2
 * revert fell through to viem's own last resort:
 *
 *     Execution reverted for an unknown reason.
 *
 * Which is what the operator actually saw when `postJob` failed. The reason was
 * present, on the wire, in the response — and nothing read it.
 *
 * Three of the errors carry arguments, and in those the arguments ARE the
 * explanation. `TooLate` is a label. `TooLate(nowTs, deadline)` says the window
 * closed 112 minutes ago, which is the sentence a person needs. Decoding the
 * name and dropping the args would repeat the mistake one level up.
 */
import { decodeErrorResult, type Abi, type Hex } from 'viem'

/**
 * Pull the revert payload out of whatever viem wrapped it in.
 *
 * viem nests: TransactionExecutionError → ExecutionRevertedError →
 * RpcRequestError, and which link carries `.data` depends on whether the failure
 * came from `eth_estimateGas`, `eth_call` or a receipt. So walk the whole chain
 * rather than guessing a depth, and fall back to scanning the message text,
 * because some providers only put the payload there.
 */
export function extractRevertData(error: unknown): Hex | null {
  const seen = new Set<unknown>()
  let node: unknown = error
  while (node && typeof node === 'object' && !seen.has(node)) {
    seen.add(node)
    const rec = node as Record<string, unknown>
    for (const key of ['data', 'raw']) {
      const v = rec[key]
      // A bare `0x` is "reverted with no data" — a real answer, and not one this
      // can decode. Anything shorter than a selector is not a payload.
      if (typeof v === 'string' && /^0x[0-9a-fA-F]{8,}$/.test(v)) return v as Hex
      // Some errors nest one more level: { data: { data: '0x...' } }
      if (v && typeof v === 'object') {
        const inner = (v as Record<string, unknown>).data
        if (typeof inner === 'string' && /^0x[0-9a-fA-F]{8,}$/.test(inner)) return inner as Hex
      }
    }
    node = rec.cause
  }
  const text = error instanceof Error ? error.message : String(error)
  // Long enough to be a selector plus at least one word of arguments, or a bare
  // selector at a word boundary. Greedy so a payload with args wins over its own
  // first four bytes.
  const m = text.match(/0x[0-9a-fA-F]{8}(?:[0-9a-fA-F]{64})*/g)
  if (!m) return null
  return m.sort((a, b) => b.length - a.length)[0] as Hex
}

export type DecodedCustomError = {
  name: string
  args: readonly unknown[]
  /** One sentence, arguments folded in. */
  message: string
}

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`

/**
 * Seconds as the largest unit that does not lose the point.
 *
 * Minutes hold until THREE hours rather than one, because the interesting gaps
 * here sit in the one-to-three-hour band: the backstop that settles a lapsed job
 * lands every 80-100 minutes and the default delivery window is four hours. On an
 * hours-from-3600s scale, 90 minutes rounds to "2 hours" — a 33% error in the one
 * range where the number is being used to decide whether to wait.
 */
function humanGap(seconds: number): string {
  const s = Math.abs(Math.round(seconds))
  if (s < 60) return plural(s, 'second')
  if (s < 3 * 3600) return plural(Math.round(s / 60), 'minute')
  if (s < 86400) return plural(Math.round(s / 3600), 'hour')
  return plural(Math.round(s / 86400), 'day')
}

/**
 * A sentence for a decoded error.
 *
 * The three with arguments get them folded in; the rest get a fixed explanation
 * of what the caller should do. Anything not listed still returns its NAME
 * rather than falling back to "unknown reason" — a name is a poor message and an
 * enormous improvement on no message.
 */
export function explainCustomError(name: string, args: readonly unknown[]): string {
  const n = (i: number) => Number(args[i] as bigint | number)
  switch (name) {
    case 'TooLate': {
      const gap = humanGap(n(0) - n(1))
      return `too late — that window closed ${gap} ago, and the job can only be settled now, not acted on.`
    }
    case 'TooEarly': {
      const gap = humanGap(n(1) - n(0))
      return `too early — that deadline is still ${gap} away.`
    }
    case 'ScoreTooLow':
      return `the worker's credit score is ${n(0)} and this job requires ${n(1)}.`
    case 'WrongStatus':
      return 'the job already moved to another status — reload and check where it actually is.'
    case 'NoSuchJob':
      return 'no job with that id exists on this contract. If the market address changed, ids restart at 1.'
    case 'SelfWork':
      return 'an agent cannot work a job its own account posted.'
    case 'NotRequester':
      return 'only the agent that posted this job can do that.'
    case 'NotWorker':
      return 'only the agent that accepted this job can submit work for it.'
    case 'NotArbiter':
      return 'only the arbiter can resolve a dispute.'
    case 'NothingToWithdraw':
      return 'there is no credited balance to withdraw for that address.'
    case 'BountyTooLow':
      return 'the bounty is below this contract’s minimum.'
    case 'BadWindow':
      return 'the requested delivery window is outside the contract’s permitted range.'
    case 'RegistryUnavailable':
      return 'the credit registry did not answer, so the score gate could not be checked.'
    case 'TransferFailed':
      return 'the token transfer failed — check the token balance and allowance.'
    case 'PayeeAlreadySet':
      return 'a payee is already set for this job and cannot be changed.'
    case 'ZeroPayee':
    case 'ZeroFeeRecipient':
      return 'that address cannot be zero.'
    case 'BadPayeeAmount':
      return 'the payee amount is not valid for this job.'
    case 'NotAContract':
      return `${String(args[0] ?? 'that address')} is not a contract.`
    default:
      // Construction-time guards (FeeTooHigh, BondTooHigh, ForfeitTooHigh,
      // MinBountyTooHigh) land here. They cannot occur post-deployment, so a
      // bespoke sentence for each would be words nobody reads.
      return `the contract rejected the call with ${name}.`
  }
}

/**
 * Decode revert data against an ABI. Null when there is nothing to decode or the
 * payload is not one of this ABI's errors.
 *
 * Returning null rather than a guess matters: a payload this ABI does not
 * recognise may be a DIFFERENT contract's error, and naming it with this one's
 * vocabulary would be confidently wrong.
 */
export function decodeCustomError(data: Hex, abi: Abi): DecodedCustomError | null {
  try {
    const { errorName, args } = decodeErrorResult({ abi, data })
    const list = (args ?? []) as readonly unknown[]
    return { name: errorName, args: list, message: explainCustomError(errorName, list) }
  } catch {
    return null
  }
}

/** The whole path: an error from viem to a sentence, or null. */
export function explainRevert(error: unknown, abi: Abi): DecodedCustomError | null {
  const data = extractRevertData(error)
  if (!data) return null
  return decodeCustomError(data, abi)
}
