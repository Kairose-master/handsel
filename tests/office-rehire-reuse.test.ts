import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

function codeOnly(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const hire = readFileSync('lib/office-hire.ts', 'utf8')
const office = readFileSync('lib/office.ts', 'utf8')

describe('re-hiring a template into an office it already occupies', () => {
  it('reuses by default, and only builds a second desk when asked', () => {
    // The failure this closes: a re-hire minted "AWS Reader 2" with a fresh
    // smart account and no ETH. With no paymaster that agent cannot transact
    // at all, so the owner's hand-funded desk sat idle beside a duplicate that
    // could never work — and the hire reported success.
    const body = codeOnly(hire)
    expect(body).toContain('input.freshAgents ? new Map<string, string>() : await existingRoleAgents')
  })

  it('keeps the wallet and refreshes only what the template owns', () => {
    // The wallet, its address and the ETH in it are the entire reason to
    // reuse the row. Instructions and the auto-mine flag come from the
    // template and may legitimately have changed.
    // The reuse branch alone — the else branch below it legitimately mints a
    // walletAddress, and slicing past it would assert nothing.
    const start = hire.indexOf('reused.push(name)')
    const update = hire.slice(start, hire.indexOf('} else {', start))
    expect(update).toContain('customInstructions')
    expect(update).toContain('autoMine')
    expect(update).not.toContain('walletAddress')
    expect(update).not.toContain('smartAccountAddress')
  })

  it('stamps the role id even on reuse, so the next match is durable', () => {
    // The office that exposed this was hired before role_id existed and can
    // only be matched by name. Stamping on every hire is what stops that
    // fallback from being needed twice.
    expect(codeOnly(hire)).toContain('setAgentOfficeSlot(agentId, slot, role.id)')
  })
})

describe('how an existing role agent is found', () => {
  const finder = codeOnly(hire.slice(hire.indexOf('async function existingRoleAgents'), hire.indexOf('/** Real quote')))

  it('prefers the stored role id over the name', () => {
    expect(finder.indexOf('officeRoleAgents')).toBeLessThan(finder.indexOf('pattern.test'))
  })

  it('anchors the name fallback', () => {
    // "AWS Reader" and "AWS Reader 2" are the same role; "AWS Reader Backup"
    // is a different agent the owner made on purpose.
    const re = new RegExp('^AWS Reader( \\d+)?$')
    expect(re.test('AWS Reader')).toBe(true)
    expect(re.test('AWS Reader 2')).toBe(true)
    expect(re.test('AWS Reader Backup')).toBe(false)
    expect(finder).toContain('( \\\\d+)?$')
  })

  it('refuses an ambiguous name rather than guessing', () => {
    // Reusing the wrong agent is worse than making a new one: it would
    // repoint someone else's funded worker at a role they did not hire it for.
    expect(finder).toContain('matches.length === 1')
  })

  it('only ever considers the caller’s own agents', () => {
    expect(finder).toContain('eq(agent.userId, userId)')
  })
})

describe('the slot table', () => {
  it('adds role_id before anything selects it', () => {
    const ensure = office.slice(
      office.indexOf('async function ensureAgentOfficeSlotTable'),
      office.indexOf('export async function setAgentOfficeSlot'),
    )
    expect(ensure).toContain('ADD COLUMN IF NOT EXISTS role_id')
  })

  it('still skips a row for plain slot 1, but not when there is a role to record', () => {
    // The original early return exists so the one-office case never writes.
    // A role id is worth a row at any slot — it is the only durable handle.
    expect(codeOnly(office)).toContain('if (slot === 1 && !roleId) return')
  })

  it('never blanks a stored role id on a later slot-only write', () => {
    expect(office).toContain('COALESCE($3, agent_office_slot.role_id)')
  })
})
