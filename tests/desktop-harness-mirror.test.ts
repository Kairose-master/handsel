/**
 * The desktop Miner's harness lane (desktop/src-tauri/src/harness.rs) is the
 * THIRD copy of the harness contract, after lib/worker-harness.ts and
 * public/handsel-worker.mjs — and a drifting mirror ships a wrong command
 * line to someone's machine, which costs a real bounty. Same pinning idea as
 * tests/worker-harness.test.ts, source-level because Rust cannot be imported
 * here.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AUTODETECT_ORDER, HARNESSES, DELIVERABLE_PATH } from '@/lib/worker-harness'

const rs = readFileSync(join(process.cwd(), 'desktop', 'src-tauri', 'src', 'harness.rs'), 'utf8')

describe('desktop harness.rs mirrors lib/worker-harness.ts', () => {
  it('keeps the autodetect order', () => {
    const m = rs.match(/AUTODETECT_ORDER[^=]*=\s*\[([^\]]+)\]/)
    expect(m, 'AUTODETECT_ORDER missing from harness.rs').not.toBeNull()
    const rustOrder = [...m![1].matchAll(/"([a-z]+)"/g)].map((x) => x[1])
    expect(rustOrder).toEqual([...AUTODETECT_ORDER])
  })

  it('keeps every adapter flag the Node registry passes', () => {
    // The flags each adapter needs — including the auto-approval flag that
    // makes a headless run answerable. dsh has no adapter on either side.
    const required: Record<string, string[]> = {
      claude: ['--print', '--permission-mode', 'bypassPermissions'],
      codex: ['exec', '--cd', '--full-auto', '--skip-git-repo-check'],
      opencode: ['run', '--dir', '--auto'],
      cline: ['--yolo', '--cwd'],
      gemini: ['--yolo', '--prompt'],
    }
    for (const [id, flags] of Object.entries(required)) {
      // First, the Node side really does pass them (so this test fails on
      // EITHER side changing, not only the Rust one).
      const node = HARNESSES.find((h) => h.id === id)!
      const nodeArgv = node.argv({ brief: 'B', workdir: '/w', model: null })
      for (const f of flags) {
        expect(nodeArgv, `${id} node argv lost ${f}`).toContain(f)
        expect(rs, `${id} rust argv lost ${f}`).toContain(`"${f}"`)
      }
    }
  })

  it('never passes claude --add-dir (variadic — it eats the brief)', () => {
    // As an argv string literal — the comment explaining WHY may name it.
    expect(rs).not.toContain('"--add-dir"')
  })

  it('keeps the per-task deliverable file contract', () => {
    expect(DELIVERABLE_PATH).toContain('.handsel/')
    expect(rs).toContain('.handsel/deliverable-')
    // Sanitised id, capped — the id names a file on the owner's disk.
    expect(rs).toMatch(/take\(64\)/)
  })

  it('stages a deep-link connect instead of applying it', () => {
    const main = readFileSync(join(process.cwd(), 'desktop', 'src-tauri', 'src', 'main.rs'), 'utf8')
    // The handler must write to pending_connect, and only the confirm
    // command may write cfg.agent from it.
    expect(main).toContain('pending_connect')
    expect(main).toMatch(/fn handle_deep_link[\s\S]{0,1200}pending_connect/)
    expect(main).not.toMatch(/fn handle_deep_link[\s\S]{0,1200}save_stored_config/)
  })

  it('registers the handsel scheme in tauri.conf.json', () => {
    const conf = JSON.parse(
      readFileSync(join(process.cwd(), 'desktop', 'src-tauri', 'tauri.conf.json'), 'utf8'),
    )
    expect(conf.plugins?.['deep-link']?.desktop?.schemes).toContain('handsel')
  })
})
