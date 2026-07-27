/**
 * MCP tools — credit.
 *
 * Reading a credit position. Nothing here moves money.
 *
 * Split out of a single 75KB route file. Each case body is unchanged; only
 * where it lives moved. Returning `null` for an unrecognised name is what lets
 * the router try the next group, so a handler must never answer for a tool it
 * does not own.
 */
import { agent } from '@/lib/db/schema'
import { db } from '@/lib/db'
import { eq } from 'drizzle-orm'
import { toolText, type McpToolContext } from '../rpc'

export async function handleCredit(
  ctx: McpToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<Response | null> {
  const { id, auth, origin } = ctx
  switch (name) {
    case 'vault_status': {
      const { readMiniVaultState, readMiniVaultPosition } = await import('@/lib/onchain/mini-vault-chain')
      const state = await readMiniVaultState()
      if (!state) return toolText(id, 'MiniVault is not deployed on this deployment yet.')
      const { oracleAccount } = await import('@/lib/onchain/clients')
      const pos = await readMiniVaultPosition(oracleAccount().address)
      const lines = [
        `🏦 MiniVault ${state.address} (Sepolia testnet)`,
        `📈 ETH price (oracle mock): $${state.priceUsd.toLocaleString()}`,
        `🪙 gUSD supply: ${state.totalSupplyGusd.toFixed(2)}`,
      ]
      if (pos) {
        lines.push(
          `🔒 demo position: ${pos.collateralEth} ETH collateral / ${pos.debtGusd.toFixed(2)} gUSD debt`,
          `❤️ health factor: ${pos.healthFactor === null ? '∞ (debt-free)' : pos.healthFactor.toFixed(2)} → ${pos.liquidatable ? '⚠️ LIQUIDATABLE (anyone can call liquidate)' : '✅ healthy'}`,
        )
      }
      lines.push(`Live gauge: ${origin}/world · rules: mint gate 150% MCR, liquidation below HF 1 (close factor 50%, bonus 10%).`)
      return toolText(id, lines.join('\n'))
    }
    case 'quote_credit_line': {
      const agents = await db.select().from(agent).where(eq(agent.userId, auth.userId))
      const wantedId = args.agent_id ? String(args.agent_id) : null
      const wanted = args.agent_name ? String(args.agent_name) : null
      const target = wantedId
        ? agents.find((a) => a.id === wantedId)
        : wanted
          ? agents.find((a) => a.name.toLowerCase() === wanted.toLowerCase())
          : agents.find((a) => a.smartAccountAddress)
      if (!target) return toolText(id, 'No matching agent with a wallet — create_worker_agent (and earn or mint_test_usdc) first.', true)
      if (!target.smartAccountAddress) return toolText(id, `${target.name} has no wallet yet — it gets one on first funding/claim.`, true)
      const { usdcBalanceOf } = await import('@/lib/onchain/treasury')
      const balance = await usdcBalanceOf(target.smartAccountAddress as `0x${string}`)
      const { maxDebtUsd, healthFactor } = await import('@/lib/mini-vault')
      const pos = { collateralUnits: balance, debtUsd: 0 }
      const maxDebt = maxDebtUsd(pos, 1)
      const hfAtMax = maxDebt > 0 ? healthFactor({ ...pos, debtUsd: maxDebt }, 1) : null
      return toolText(
        id,
        `${target.name} has earned ${balance.toFixed(2)} test USDC on-chain.\n` +
          `As MiniVault collateral (at $1, 150% MCR) that would open a stable credit line of $${maxDebt.toFixed(2)}` +
          (hfAtMax ? ` (health factor ${hfAtMax.toFixed(2)} if fully drawn)` : '') +
          `.\nPreview only — testnet, nothing is escrowed or drawn.`,
      )
    }
    default:
      return null
  }
}
