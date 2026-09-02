/**
 * MCP tools — the Notion desk (lib/notion-desk.ts).
 *
 * connect_notion_desk stores a token and a database and proves both with one
 * read; notion_desk_status reads the desk back (token last-4 only) and can
 * pause, resume or disconnect it. Neither moves money. The rows do, on the
 * cron tick, from the agent chosen at connect.
 */
import { toolText, type McpToolContext } from '../rpc'

export async function handleNotion(
  ctx: McpToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<Response | null> {
  const { id, auth } = ctx
  switch (name) {
    case 'connect_notion_desk': {
      const { connectNotionDesk } = await import('@/lib/notion-desk-server')
      const r = await connectNotionDesk({
        userId: auth.userId,
        token: String(args.token ?? ''),
        database: String(args.database ?? ''),
        requesterAgentId: typeof args.agent_id === 'string' ? args.agent_id : null,
        maxBountyUsd: args.max_bounty_usd === undefined ? undefined : Number(args.max_bounty_usd),
      })
      if (!r.ok) return toolText(id, `Connect refused (${r.reason}): ${r.message}`, true)
      return toolText(
        id,
        `🗂 Notion desk connected — ${r.databaseTitle ?? 'database'} · pays from ${r.requesterAgentName}.\n` +
          (r.missing.length
            ? `⚠ Add these columns before the desk will post: ${r.missing.join(', ')}.\n`
            : 'All five required columns present.\n') +
          `Writes back: ${r.optional.length ? r.optional.join(', ') : 'Status only — add Job / Result / Proof / Note columns to see more'}.\n` +
          'Set a row\'s Status to Ready and the next cron tick escrows it. notion_desk_status shows the desk.',
      )
    }
    case 'notion_desk_status': {
      const { notionDeskStatus, setNotionDeskEnabled, disconnectNotionDesk } = await import('@/lib/notion-desk-server')
      const action = typeof args.action === 'string' ? args.action : null
      if (action === 'pause' || action === 'resume') {
        const ok = await setNotionDeskEnabled(auth.userId, action === 'resume')
        if (!ok) return toolText(id, 'No Notion desk on this account.', true)
      } else if (action === 'disconnect') {
        const ok = await disconnectNotionDesk(auth.userId)
        return toolText(id, ok ? 'Notion desk disconnected; the token is deleted. Rows already posted settle as ordinary jobs.' : 'No Notion desk on this account.', !ok)
      }
      const s = await notionDeskStatus(auth.userId)
      return toolText(id, s ?? 'No Notion desk on this account. connect_notion_desk sets one up.')
    }
    default:
      return null
  }
}
