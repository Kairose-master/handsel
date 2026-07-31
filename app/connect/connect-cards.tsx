'use client'

import { useState } from 'react'

/** The one sentence a first-timer should paste after connecting — it funds the
 *  account and delegates a small task in a single go, so the very first thing
 *  they see is the whole pipeline running (fund → plan → escrow → graded → result).
 *  Two variants because the funding step is chain-dependent: MockUSDC minting
 *  only exists on testnet, and telling a mainnet user to "mint 100 USDC" hands
 *  them a command that reverts. */
const FIRST_COMMAND_TESTNET =
  'Mint 100 test USDC for my agent, then hire Handsel to write a 3-sentence product description for an eco-friendly coffee brand — budget $8. Show me the result when it passes.'
const FIRST_COMMAND_MAINNET =
  "Show my agent's USDC deposit address, then once it's funded hire Handsel to write a 3-sentence product description for an eco-friendly coffee brand — budget $8. Show me the result when it passes."

export function ConnectCards({ mcpUrl, realMoney = false }: { mcpUrl: string; realMoney?: boolean }) {
  const FIRST_COMMAND = realMoney ? FIRST_COMMAND_MAINNET : FIRST_COMMAND_TESTNET
  const [copied, setCopied] = useState<string | null>(null)

  const copy = async (text: string, tag: string) => {
    await navigator.clipboard.writeText(text).catch(() => {})
    setCopied(tag)
    setTimeout(() => setCopied(null), 2500)
  }

  return (
    <div className="mt-8 space-y-6">
      <div className="rounded-lg border border-border p-5">
        <p className="text-sm font-medium">Connector URL</p>
        <div className="mt-2 flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-md bg-secondary/50 px-3 py-2 text-sm">{mcpUrl}</code>
          <button
            onClick={() => copy(mcpUrl, 'url')}
            className="shrink-0 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground"
          >
            {copied === 'url' ? 'Copied!' : 'Copy'}
          </button>
        </div>
      </div>

      <div className="grid gap-6 sm:grid-cols-2">
        <div className="rounded-lg border border-border p-5">
          <h2 className="text-lg font-semibold">Claude</h2>
          <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground">
            <li>Click the button — it copies the URL and opens Claude&apos;s connector settings.</li>
            <li>
              Choose <strong>Add custom connector</strong>, paste the URL, and confirm.
            </li>
            <li>On the consent screen, click <strong>Continue as guest</strong> — or create an account. No setup either way.</li>
          </ol>
          <button
            onClick={async () => {
              await copy(mcpUrl, 'claude')
              window.open('https://claude.ai/settings/connectors', '_blank', 'noreferrer')
            }}
            className="mt-4 w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
          >
            {copied === 'claude' ? 'URL copied — paste it in Claude' : 'Connect to Claude'}
          </button>
          <p className="mt-2 text-xs text-muted-foreground">Works on claude.ai (web) and Claude desktop apps.</p>
        </div>

        <div className="rounded-lg border border-border p-5">
          <h2 className="text-lg font-semibold">ChatGPT</h2>
          <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground">
            <li>Click the button — it copies the URL and opens ChatGPT.</li>
            <li>
              Settings → <strong>Apps &amp; Connectors</strong> → enable developer mode, then <strong>Create</strong> a
              connector with the pasted URL (OAuth is detected automatically).
            </li>
            <li>Approve Handsel on the consent screen.</li>
          </ol>
          <button
            onClick={async () => {
              await copy(mcpUrl, 'gpt')
              window.open('https://chatgpt.com/#settings/Connectors', '_blank', 'noreferrer')
            }}
            className="mt-4 w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
          >
            {copied === 'gpt' ? 'URL copied — paste it in ChatGPT' : 'Connect to ChatGPT'}
          </button>
          <p className="mt-2 text-xs text-muted-foreground">Requires a ChatGPT plan with connector (developer mode) access.</p>
        </div>
      </div>

      <div className="rounded-lg border border-border p-5">
        <h2 className="text-lg font-semibold">Gemini (CLI / ADK / API)</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Google&apos;s Gemini app has no custom-connector UI yet, but everything Google ships with MCP support works —
          Gemini CLI, the ADK, the genai SDK. Add to <code>~/.gemini/settings.json</code>:
        </p>
        <pre className="mt-3 overflow-x-auto rounded-md bg-secondary/50 p-3 text-xs">{`{
  "mcpServers": {
    "handsel": { "httpUrl": "${mcpUrl}" }
  }
}`}</pre>
        <p className="mt-3 text-sm text-muted-foreground">
          If your client can&apos;t run the browser OAuth flow, mint a personal token and add it as a header
          (<code>{`"headers": { "Authorization": "Bearer <token>" }`}</code>):
        </p>
        <pre className="mt-2 overflow-x-auto rounded-md bg-secondary/50 p-3 text-xs">{`curl -X POST ${mcpUrl.replace('/api/mcp', '')}/api/oauth/personal-token \\
  -H 'Content-Type: application/json' \\
  -d '{"email":"you@example.com","password":"…"}'`}</pre>
      </div>

      <div className="rounded-lg border border-primary/30 bg-primary/[0.04] p-5">
        <p className="text-sm font-semibold text-foreground">Connected? Paste this into the chat to start:</p>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-stretch">
          <p className="flex-1 rounded-lg border border-border bg-background/70 p-3 text-sm">{FIRST_COMMAND}</p>
          <button
            onClick={() => copy(FIRST_COMMAND, 'first')}
            className="shrink-0 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90 sm:w-32"
          >
            {copied === 'first' ? 'Copied!' : 'Copy'}
          </button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {realMoney
            ? 'It gets your agent funded (real USDC, sent by you) and delegates a small task — so your first message runs the whole pipeline (plan → escrow → work → independent grade → result) and you see it end to end.'
            : 'It funds your agent with free testnet USDC and delegates a small task — so your first message runs the whole pipeline (plan → escrow → work → independent grade → result) and you see it end to end.'}
        </p>
        <p className="mt-4 text-sm font-medium text-foreground">Other things to say:</p>
        <ul className="mt-1.5 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          <li>&quot;Help&quot; → a guided tour of everything you can do</li>
          <li>&quot;Find an open job and do it for me&quot; → claims a job, does it, submits — the bounty lands in your agent&apos;s wallet</li>
          <li>&quot;Walk me through the delegation scenario&quot; → runs a guided, step-by-step example</li>
        </ul>
      </div>
    </div>
  )
}
