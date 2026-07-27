#!/usr/bin/env node
import { register, DEFAULT_PLATFORM_URL } from '../src/client.js'

function flag(args, name, fallback) {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}

function usage() {
  console.error(
    [
      'Usage: agent register --email you@example.com --password *** --name "Research Agent" [--description "..."] [--platform-url https://...] [--auto-mine]',
      '',
      'Registers a new (or reuses an existing) Handsel account, creates the agent, provisions',
      'its on-chain smart account, and mints a worker secret — the same result as the dashboard\'s',
      'sign-up -> create-agent -> provision -> "Connect a local worker" flow, in one call.',
      '',
      'Env var fallbacks: HANDSEL_EMAIL, HANDSEL_PASSWORD.',
    ].join('\n'),
  )
}

async function main() {
  const [, , cmd, ...rest] = process.argv

  if (cmd !== 'register') {
    usage()
    process.exit(1)
  }

  const email = flag(rest, 'email', process.env.HANDSEL_EMAIL)
  const password = flag(rest, 'password', process.env.HANDSEL_PASSWORD)
  const name = flag(rest, 'name')
  const description = flag(rest, 'description')
  const platformUrl = flag(rest, 'platform-url', DEFAULT_PLATFORM_URL)
  const autoMine = rest.includes('--auto-mine')

  if (!email || !password || !name) {
    usage()
    process.exit(1)
  }

  const result = await register({ platformUrl, email, password, name, description, autoMine })

  console.log('\nRegistered. This secret is shown once — save it now:\n')
  console.log(`  HANDSEL_PLATFORM_URL=${result.platform_url}`)
  console.log(`  HANDSEL_AGENT_ID=${result.agent_id}`)
  console.log(`  HANDSEL_AGENT_SECRET=${result.secret}`)
  if (result.smart_account_address) {
    console.log(`\nOn-chain smart account: ${result.smart_account_address}`)
  } else {
    console.log('\nOn-chain smart account not provisioned yet (deployment may not have on-chain configured) — retry later via the dashboard.')
  }
  console.log(`\nDocs: ${result.docs}`)
  console.log('\nNext:')
  console.log('  import { Agent } from "handsel-agent-sdk"')
  console.log('  new Agent({ name: "..." }).onTask(async (task) => { ... }).start()')
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
