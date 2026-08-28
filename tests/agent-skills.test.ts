import { describe, it, expect } from 'vitest'
import {
  normalizeClawhubSkillDetail,
  renderSkillsBlock,
  composeEffectiveTask,
  SKILL_INSTRUCTIONS_LIMIT,
} from '@/lib/agent-skills'

describe('normalizeClawhubSkillDetail', () => {
  const realShapedDetail = {
    skill: {
      slug: 'pdf-toolkit',
      displayName: 'PDF Toolkit',
      summary: 'Work with PDFs.',
      description: '---\nname: pdf-toolkit\n---\n\n# PDF Toolkit\n\nDo PDF things properly.',
      latestVersion: { version: '2.1.0', createdAt: 1 },
    },
  }

  it('parses the real detail shape (skill.description carries the full document)', () => {
    const d = normalizeClawhubSkillDetail(realShapedDetail)
    expect(d).toMatchObject({
      slug: 'pdf-toolkit',
      name: 'PDF Toolkit',
      version: '2.1.0',
      summary: 'Work with PDFs.',
    })
    expect(d!.instructions).toContain('Do PDF things properly.')
  })

  it('falls back to the slug when displayName is missing, and null version when unversioned', () => {
    const d = normalizeClawhubSkillDetail({ skill: { slug: 's1', description: 'doc' } })
    expect(d).toMatchObject({ slug: 's1', name: 's1', version: null, summary: '' })
  })

  it('rejects an entry with no instruction document — a listing is not a skill', () => {
    expect(normalizeClawhubSkillDetail({ skill: { slug: 's1', summary: 'only a blurb', description: '   ' } })).toBeNull()
  })

  it('rejects non-objects, missing skill wrapper, and missing slug', () => {
    expect(normalizeClawhubSkillDetail(null)).toBeNull()
    expect(normalizeClawhubSkillDetail('x')).toBeNull()
    expect(normalizeClawhubSkillDetail({})).toBeNull()
    expect(normalizeClawhubSkillDetail({ skill: { description: 'doc' } })).toBeNull()
  })
})

describe('renderSkillsBlock', () => {
  it('renders empty input to the empty string — no skills means no block at all', () => {
    expect(renderSkillsBlock([])).toBe('')
  })

  it('names the authority (owner-installed) and pins each skill by slug@version', () => {
    const block = renderSkillsBlock([
      { slug: 'a', name: 'Alpha', version: '1.0.0', instructions: 'Do A.', truncated: false },
      { slug: 'b', name: 'Beta', version: null, instructions: 'Do B.', truncated: false },
    ])
    expect(block).toContain("this agent's owner installed")
    expect(block).toContain('### Skill: Alpha (a@1.0.0)')
    expect(block).toContain('### Skill: Beta (b)')
    expect(block).toContain('Do A.')
    expect(block).toContain('Do B.')
  })

  it('discloses a truncated document in platform-authored text — silent cuts are the defect', () => {
    const block = renderSkillsBlock([{ slug: 'a', name: 'Alpha', version: null, instructions: 'partial…', truncated: true }])
    expect(block).toContain('PLATFORM NOTICE')
    expect(block).toContain(SKILL_INSTRUCTIONS_LIMIT.toLocaleString('en-US'))
  })

  it('says skills never override the task acceptance criteria', () => {
    const block = renderSkillsBlock([{ slug: 'a', name: 'A', version: null, instructions: 'x', truncated: false }])
    expect(block).toContain('never override')
  })
})

describe('composeEffectiveTask — byte-compatible with the old inline behavior when no skills', () => {
  it('bare task with nothing else is returned verbatim', () => {
    expect(composeEffectiveTask({ customInstructions: null, skillsBlock: '', task: 'Write a haiku.' })).toBe('Write a haiku.')
  })

  it('customInstructions alone reproduces the exact pre-skills format', () => {
    // Pinned: this exact string is what every existing agent's dispatch
    // produced before skills existed. It must not drift.
    expect(composeEffectiveTask({ customInstructions: 'Be terse.', skillsBlock: '', task: 'T' })).toBe(
      'Be terse.\n\n---\n\nTask: T',
    )
  })

  it('skills alone form the prefix when there are no custom instructions', () => {
    expect(composeEffectiveTask({ customInstructions: null, skillsBlock: 'SKILLS', task: 'T' })).toBe(
      'SKILLS\n\n---\n\nTask: T',
    )
  })

  it('custom instructions come before skills — the owner outranks the installed documents', () => {
    expect(composeEffectiveTask({ customInstructions: 'C', skillsBlock: 'S', task: 'T' })).toBe(
      'C\n\n---\n\nS\n\n---\n\nTask: T',
    )
  })
})
