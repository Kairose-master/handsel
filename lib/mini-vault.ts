/**
 * MiniVault — the GIWA MiniDAI flow (ETH collateral → stablecoin debt →
 * price oracle → health factor → liquidation → AMM) as one pure, unit-testable
 * engine. No chain calls: the oracle price is an input, positions are plain
 * values, and every function is a preview/decision the caller can act on.
 *
 * Mapped onto Handsel: an agent's earned (test) USDC or staked collateral
 * backs a stable credit line. The same math the lab teaches applies:
 *
 *   • mint gate    debt ≤ collateralValue / MCR          (over-collateralized)
 *   • health       HF = collateralValue / (debt × LIQ)   (HF < 1 → liquidatable)
 *   • liquidation  repay ≤ closeFactor × debt; seize repay × (1+bonus) / price
 *   • AMM          constant-product swap with fee — the price venue / oracle mock
 *
 * Gas cost of a real liquidation is modeled as an input so "profitable for the
 * liquidator?" is an explicit, testable question (the lab's closing lesson).
 */

export interface VaultParams {
  /** Minimum collateral ratio for MINTING new debt (e.g. 1.5 = 150%). */
  mcr: number
  /** Collateral ratio at which a position becomes LIQUIDATABLE (< mcr). */
  liqRatio: number
  /** Max fraction of debt a single liquidation may repay (e.g. 0.5). */
  closeFactor: number
  /** Liquidator's bonus on seized collateral (e.g. 0.1 = 10%). */
  liquidationBonus: number
}

export const DEFAULT_VAULT: VaultParams = { mcr: 1.5, liqRatio: 1.2, closeFactor: 0.5, liquidationBonus: 0.1 }

export interface Position {
  collateralUnits: number // units of the collateral asset
  debtUsd: number // stable debt outstanding
}

const r2 = (n: number) => Math.round(n * 100) / 100

/** USD value of the collateral at the oracle price. */
export function collateralValueUsd(pos: Position, priceUsd: number): number {
  return pos.collateralUnits * priceUsd
}

/** Maximum total debt the position may carry at this price (mint gate). */
export function maxDebtUsd(pos: Position, priceUsd: number, p: VaultParams = DEFAULT_VAULT): number {
  return r2(collateralValueUsd(pos, priceUsd) / p.mcr)
}

/** Additional stable credit that can still be drawn right now. */
export function availableToDrawUsd(pos: Position, priceUsd: number, p: VaultParams = DEFAULT_VAULT): number {
  return r2(Math.max(0, maxDebtUsd(pos, priceUsd, p) - pos.debtUsd))
}

/** Health factor: > 1 healthy, < 1 liquidatable. Infinity when debt-free. */
export function healthFactor(pos: Position, priceUsd: number, p: VaultParams = DEFAULT_VAULT): number {
  if (pos.debtUsd <= 0) return Infinity
  return collateralValueUsd(pos, priceUsd) / (pos.debtUsd * p.liqRatio)
}

export function isLiquidatable(pos: Position, priceUsd: number, p: VaultParams = DEFAULT_VAULT): boolean {
  return healthFactor(pos, priceUsd, p) < 1
}

export interface DrawPreview {
  ok: boolean
  reason?: string
  position: Position
  healthAfter: number
}

/** Preview drawing more stable credit against the position. */
export function previewDraw(pos: Position, priceUsd: number, drawUsd: number, p: VaultParams = DEFAULT_VAULT): DrawPreview {
  if (drawUsd <= 0) return { ok: false, reason: 'draw must be positive', position: pos, healthAfter: healthFactor(pos, priceUsd, p) }
  const after: Position = { ...pos, debtUsd: r2(pos.debtUsd + drawUsd) }
  if (after.debtUsd > maxDebtUsd(pos, priceUsd, p)) {
    return { ok: false, reason: `debt $${after.debtUsd} would exceed max $${maxDebtUsd(pos, priceUsd, p)} at ${p.mcr * 100}% MCR`, position: pos, healthAfter: healthFactor(pos, priceUsd, p) }
  }
  return { ok: true, position: after, healthAfter: healthFactor(after, priceUsd, p) }
}

export interface LiquidationPreview {
  ok: boolean
  reason?: string
  /** Debt actually repaid (≤ closeFactor × debt, ≤ requested). */
  repaidUsd: number
  /** Collateral units seized = repaid × (1+bonus) / price, capped by balance. */
  seizedUnits: number
  seizedValueUsd: number
  /** Liquidator P&L: seized value − repaid − gas. The lab's real-profit lesson. */
  liquidatorProfitUsd: number
  position: Position
  healthAfter: number
}

/** Preview a liquidation of an unhealthy position. */
export function previewLiquidation(
  pos: Position,
  priceUsd: number,
  repayRequestUsd: number,
  p: VaultParams = DEFAULT_VAULT,
  gasCostUsd = 0,
): LiquidationPreview {
  const hf = healthFactor(pos, priceUsd, p)
  const base = { repaidUsd: 0, seizedUnits: 0, seizedValueUsd: 0, liquidatorProfitUsd: 0, position: pos, healthAfter: hf }
  if (!isLiquidatable(pos, priceUsd, p)) return { ok: false, reason: `position healthy (HF ${hf.toFixed(2)})`, ...base }
  if (repayRequestUsd <= 0) return { ok: false, reason: 'repay must be positive', ...base }

  const repaid = r2(Math.min(repayRequestUsd, pos.debtUsd * p.closeFactor))
  const seizedUnitsRaw = (repaid * (1 + p.liquidationBonus)) / priceUsd
  const seizedUnits = Math.min(seizedUnitsRaw, pos.collateralUnits)
  const seizedValueUsd = r2(seizedUnits * priceUsd)
  const after: Position = { collateralUnits: pos.collateralUnits - seizedUnits, debtUsd: r2(pos.debtUsd - repaid) }
  return {
    ok: true,
    repaidUsd: repaid,
    seizedUnits,
    seizedValueUsd,
    liquidatorProfitUsd: r2(seizedValueUsd - repaid - gasCostUsd),
    position: after,
    healthAfter: healthFactor(after, priceUsd, p),
  }
}

// ─── AMM (constant product x·y=k, fee in bps) — the lab's DEX/price venue ──

/** Output amount for a swap of `amountIn` against reserves, fee in bps. */
export function getAmountOut(amountIn: number, reserveIn: number, reserveOut: number, feeBps = 30): number {
  if (amountIn <= 0 || reserveIn <= 0 || reserveOut <= 0) return 0
  const inWithFee = amountIn * (1 - feeBps / 10_000)
  return (inWithFee * reserveOut) / (reserveIn + inWithFee)
}

/** Marginal (spot) price of the OUT asset in units of IN. */
export function spotPrice(reserveIn: number, reserveOut: number): number {
  return reserveIn / reserveOut
}
