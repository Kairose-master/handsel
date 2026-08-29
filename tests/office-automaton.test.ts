/**
 * The Office Automaton's planner — the pure arithmetic that moves real USDC
 * between an owner's own agents (lib/office-automaton.ts). Tested the way
 * planSponsorship (local-paymaster) and planUsdcFunding are: every bound the
 * module's header claims is a case here, because the bounds ARE the safety
 * argument.
 */
import { describe, expect, it } from 'vitest'
import {
  AUTOMATON_BOND_FLOOR_USD,
  AUTOMATON_MAX_TOPUP_USD,
  AUTOMATON_WINDOW_BUDGET_USD,
  planDeskReadiness,
} from '@/lib/office-automaton'
import { USDC_FUNDING_RESERVE_USD } from '@/lib/agent-usdc-funding'

const member = (id: string, heldUsd: number | null) => ({ id, heldUsd })

describe('planDeskReadiness', () => {
  it('tops a short member up to the floor from the richest funder', () => {
    const plan = planDeskReadiness({
      members: [member('worker', 0)],
      funders: [member('worker', 0), member('rich', 4), member('poor', 1)],
      spentInWindowUsd: 0,
    })
    expect(plan.transfers).toEqual([{ toId: 'worker', fromId: 'rich', amountUsd: AUTOMATON_BOND_FLOOR_USD }])
    expect(plan.refusals).toEqual([])
  })

  it('sends only the shortfall, never past the floor', () => {
    const plan = planDeskReadiness({
      members: [member('worker', 0.2)],
      funders: [member('rich', 4)],
      spentInWindowUsd: 0,
    })
    expect(plan.transfers[0].amountUsd).toBeCloseTo(AUTOMATON_BOND_FLOOR_USD - 0.2, 6)
  })

  it('counts members at or above the floor as ready and moves nothing', () => {
    const plan = planDeskReadiness({
      members: [member('a', AUTOMATON_BOND_FLOOR_USD), member('b', 3)],
      funders: [member('rich', 4)],
      spentInWindowUsd: 0,
    })
    expect(plan.transfers).toEqual([])
    expect(plan.ready).toBe(2)
  })

  it('an unreadable balance is a named refusal, never treated as zero', () => {
    const plan = planDeskReadiness({
      members: [member('worker', null)],
      funders: [member('rich', 4)],
      spentInWindowUsd: 0,
    })
    expect(plan.transfers).toEqual([])
    expect(plan.refusals).toEqual([{ toId: 'worker', why: 'unreadable' }])
  })

  it('refuses once the window budget is spent', () => {
    const plan = planDeskReadiness({
      members: [member('worker', 0)],
      funders: [member('rich', 4)],
      spentInWindowUsd: AUTOMATON_WINDOW_BUDGET_USD,
    })
    expect(plan.refusals).toEqual([{ toId: 'worker', why: 'over-window-budget' }])
  })

  it('clamps to the remaining budget rather than refusing outright', () => {
    const plan = planDeskReadiness({
      members: [member('worker', 0)],
      funders: [member('rich', 4)],
      spentInWindowUsd: AUTOMATON_WINDOW_BUDGET_USD - 0.1,
    })
    expect(plan.transfers[0].amountUsd).toBeCloseTo(0.1, 6)
  })

  it('caps a single transfer at AUTOMATON_MAX_TOPUP_USD', () => {
    const plan = planDeskReadiness({
      members: [member('worker', 0)],
      funders: [member('rich', 100)],
      spentInWindowUsd: 0,
      floorUsd: 5, // a floor bigger than the per-transfer cap
    })
    expect(plan.transfers[0].amountUsd).toBe(AUTOMATON_MAX_TOPUP_USD)
  })

  it("holds back the funder's reserve and refuses when nothing is spendable", () => {
    const plan = planDeskReadiness({
      members: [member('worker', 0)],
      funders: [member('only', USDC_FUNDING_RESERVE_USD)],
      spentInWindowUsd: 0,
    })
    expect(plan.refusals).toEqual([{ toId: 'worker', why: 'no-funder' }])
  })

  it('a member may not fund itself, even as the richest wallet', () => {
    const plan = planDeskReadiness({
      // Below the floor but rich enough to be the top funder after reserve —
      // held 0.24 < floor 0.25, spendable 0.24-0.50 < 0... use a bigger floor.
      members: [member('worker', 1)],
      funders: [member('worker', 1)],
      spentInWindowUsd: 0,
      floorUsd: 2,
    })
    expect(plan.refusals).toEqual([{ toId: 'worker', why: 'no-funder' }])
  })

  it('draws a funder down across the plan — two members never share the same dollar', () => {
    const spendable = USDC_FUNDING_RESERVE_USD + 0.3 // exactly $0.30 to give
    const plan = planDeskReadiness({
      members: [member('a', 0), member('b', 0)],
      funders: [member('rich', spendable)],
      spentInWindowUsd: 0,
    })
    // First gets the full floor ($0.25), second only what is left ($0.05).
    expect(plan.transfers).toHaveLength(2)
    expect(plan.transfers[0].amountUsd).toBeCloseTo(0.25, 6)
    expect(plan.transfers[1].amountUsd).toBeCloseTo(0.05, 6)
  })

  it('refuses below-dust rather than sending a one-cent UserOperation', () => {
    const plan = planDeskReadiness({
      members: [member('worker', AUTOMATON_BOND_FLOOR_USD - 0.01)],
      funders: [member('rich', 4)],
      spentInWindowUsd: 0,
    })
    expect(plan.refusals).toEqual([{ toId: 'worker', why: 'below-dust' }])
  })

  it('an unreadable funder is simply not a funder', () => {
    const plan = planDeskReadiness({
      members: [member('worker', 0)],
      funders: [member('ghost', null), member('rich', 4)],
      spentInWindowUsd: 0,
    })
    expect(plan.transfers[0].fromId).toBe('rich')
  })
})
