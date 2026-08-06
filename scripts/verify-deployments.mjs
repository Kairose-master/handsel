#!/usr/bin/env node
/**
 * Ask the chain whether `docs/deployments.md` is telling the truth.
 *
 * §27's invariant, made runnable: *a report that finds nothing is a claim, not a
 * result — ask for the command, and run it.* This is that command. It exists so
 * "the deployment table is correct" is something anyone can check in ten
 * seconds instead of something we assert and a reader believes.
 *
 * It was written after the table shipped a stale Base Sepolia market address.
 * The address was not invented: it is a real LaborMarketV2 with one job in it,
 * left behind by an earlier rehearsal deploy and still quoted in a test comment,
 * which is exactly the kind of wrong that survives review — every character of
 * it checks out except which contract the deployment actually points at.
 *
 * Reads addresses out of the doc, resolves each live deployment's own answer
 * from `GET /api/tasks` (`meta.contractAddress`), and reads the contracts
 * themselves. No env, no keys, nothing written.
 *
 *   node scripts/verify-deployments.mjs
 *
 * Exit 0 when the doc, the live deployments and the chain agree; 1 otherwise.
 */
import { readFileSync } from 'node:fs'
import { createPublicClient, http, getAddress } from 'viem'
import { base, baseSepolia } from 'viem/chains'

const DEPLOYMENTS = [
  { label: 'mainnet', url: 'https://handsel-main.vercel.app', chain: base, rpc: 'https://mainnet.base.org' },
  { label: 'testnet', url: 'https://handsel-nu.vercel.app', chain: baseSepolia, rpc: 'https://sepolia.base.org' },
]

const MARKET_ABI = [
  { type: 'function', name: 'usdc', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'registry', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'jobCount', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
]

const doc = readFileSync('docs/deployments.md', 'utf8')
const documented = new Set([...doc.matchAll(/0x[0-9a-fA-F]{40}/g)].map((m) => getAddress(m[0])))

let failed = 0
const fail = (msg) => {
  console.log(`  ✖ ${msg}`)
  failed++
}

for (const d of DEPLOYMENTS) {
  console.log(`\n${d.label} — ${d.url}`)

  let meta
  try {
    meta = (await (await fetch(`${d.url}/api/tasks`)).json()).meta
  } catch (error) {
    fail(`could not read ${d.url}/api/tasks — ${String(error).split('\n')[0]}`)
    continue
  }
  if (!meta?.contractAddress) {
    fail('the live feed reports no contractAddress')
    continue
  }

  const address = getAddress(meta.contractAddress)
  console.log(`  chain      ${meta.chainName} (${meta.chainId}), realMoney=${meta.realMoney}`)
  console.log(`  market     ${address}`)

  if (meta.chainId !== d.chain.id) {
    fail(`the feed says chain ${meta.chainId} but this script expects ${d.chain.id} — one of them is wrong`)
  }

  // The check the stale address would have failed: the doc must name the
  // contract this deployment is actually pointed at, not one it used to be.
  if (!documented.has(address)) {
    fail(`docs/deployments.md does not mention ${address}, which is the market ${d.url} is live on`)
  }

  const client = createPublicClient({ chain: d.chain, transport: http(d.rpc) })
  try {
    const code = await client.getCode({ address })
    if (!code || code === '0x') {
      fail(`no contract at ${address} on ${d.chain.name}`)
      continue
    }
    const [usdc, registry, jobCount] = await Promise.all([
      client.readContract({ address, abi: MARKET_ABI, functionName: 'usdc' }),
      client.readContract({ address, abi: MARKET_ABI, functionName: 'registry' }),
      client.readContract({ address, abi: MARKET_ABI, functionName: 'jobCount' }),
    ])
    console.log(`  usdc       ${usdc}`)
    console.log(`  registry   ${registry}`)
    console.log(`  jobCount   ${jobCount}`)
  } catch (error) {
    fail(`could not read the market — ${String(error).split('\n')[0]}`)
  }
}

// Addresses the doc names that no live deployment points at. Not automatically
// wrong — USDC and the registry belong here too — but a market address in this
// list is the stale-deploy shape, so it is printed rather than judged.
console.log(`\n${documented.size} address(es) named in docs/deployments.md`)

console.log(failed === 0 ? '\n✔ doc, live deployments and chain agree\n' : `\n✖ ${failed} problem(s)\n`)
process.exit(failed === 0 ? 0 : 1)
