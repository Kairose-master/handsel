/**
 * Capabilities have to be reachable from the page a person would look on.
 *
 * Three times now a feature has been built, correct, and effectively hidden:
 * the storefront switch existed only in the MCP connector
 * (docs/failure-modes.md §42); the commission dispatcher ran only from a
 * cron; and GitHub — sign-in AND the App that opens pull requests — was
 * linked from /start, from /admin/access, and from error text you only see
 * after something has already failed. Settings, the page you open to connect
 * an account, said nothing about GitHub at all.
 *
 * None of those looked broken. A capability nobody can find behaves exactly
 * like a capability nobody wants, and that is the reading it invites — which
 * is why this is worth a test rather than a note.
 */
import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

const settings = readFileSync('app/(dashboard)/settings/page.tsx', 'utf8')
const actions = readFileSync('app/actions/github-connection.ts', 'utf8')

describe('Settings offers the GitHub connection', () => {
  it('mounts the section, not merely defines it', () => {
    // Asserting the bare name passes on the declaration alone — the same
    // "present but not wired" shape as the defect this pins.
    expect(settings).toMatch(/<GithubSection\b/)
  })

  it('links the real OAuth entry point and returns to settings', () => {
    expect(settings).toContain('/api/github/oauth/start')
    expect(settings).toContain('next=/settings')
  })

  it('offers the App install, which is what actually grants repo access', () => {
    // Signing in with GitHub and letting the platform open a PR are two
    // different grants; showing only the first strands the user connected
    // but unable to post a repo job.
    expect(settings).toContain('installUrl')
  })

  it('can disconnect, not only connect', () => {
    expect(actions).toContain('disconnectMyGithub')
    expect(settings).toContain('disconnectMyGithub')
  })

  it('reads state through the shared helper the connector also uses', () => {
    // githubConnectionFor takes a userId explicitly so the MCP connector and
    // the web UI cannot disagree about whether you are connected.
    expect(actions).toContain('githubConnectionFor')
  })
})
