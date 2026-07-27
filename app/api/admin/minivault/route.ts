import {
  deployMiniVault,
  demoDepositAndMint,
  prepLiquidator,
  readMiniVaultPosition,
  readMiniVaultState,
  runLiquidationDemo,
  setMiniVaultPrice,
} from '@/lib/onchain/mini-vault-chain'
import { oracleAccount } from '@/lib/onchain/clients'

/**
 * MiniVault ops — deploy and drive the on-chain GIWA engine with the platform
 * oracle wallet. Guarded by CRON_SECRET.
 *
 *   POST /api/admin/minivault?action=deploy[&price=3000][&force=1]
 *   with Authorization: Bearer $CRON_SECRET — a secret in the URL is refused
 *   POST …&action=set-price&price=1200        (Oracle Mock price push)
 *   POST …&action=demo[&eth=0.002]            (deposit + mint half of max)
 *   POST …&action=read                        (state + oracle position)
 */
export const dynamic = 'force-dynamic'
export const maxDuration = 120

export async function POST(request: Request): Promise<Response> {
  const { requireOperator } = await import('@/lib/admin-route')
  const auth = requireOperator(request, { mutating: true })
  if (!auth.ok) return auth.response
  const url = new URL(request.url)

  const action = url.searchParams.get('action') ?? 'read'
  try {
    if (action === 'deploy') {
      const price = Number(url.searchParams.get('price') ?? 3000)
      const force = url.searchParams.get('force') === '1'
      const { address, txHash } = await deployMiniVault(price, force)
      return Response.json({ status: 'ok', action, address, txHash, initialPriceUsd: price })
    }
    if (action === 'set-price') {
      const price = Number(url.searchParams.get('price'))
      if (!Number.isFinite(price) || price <= 0) return Response.json({ error: 'price required' }, { status: 400 })
      const txHash = await setMiniVaultPrice(price)
      return Response.json({ status: 'ok', action, priceUsd: price, txHash })
    }
    if (action === 'demo') {
      const eth = Number(url.searchParams.get('eth') ?? 0.002)
      const result = await demoDepositAndMint(eth)
      const position = await readMiniVaultPosition(oracleAccount().address)
      return Response.json({ status: 'ok', action, depositedEth: eth, ...result, position })
    }
    if (action === 'liq-prep') {
      const result = await prepLiquidator()
      return Response.json({ status: 'ok', action, ...result })
    }
    if (action === 'liq-run') {
      const crash = Number(url.searchParams.get('crash') ?? 1000)
      const restore = Number(url.searchParams.get('restore') ?? 3000)
      const result = await runLiquidationDemo(crash, restore)
      return Response.json({ status: 'ok', action, crashPriceUsd: crash, restorePriceUsd: restore, ...result })
    }
    // read
    const state = await readMiniVaultState()
    if (!state) return Response.json({ status: 'ok', action, deployed: false })
    const position = await readMiniVaultPosition(oracleAccount().address)
    return Response.json({ status: 'ok', action, deployed: true, state, oraclePosition: position })
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 })
  }
}
