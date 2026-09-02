/**
 * The four Notion calls the desk makes, and nothing else.
 *
 * A thin fetch wrapper rather than the SDK: four endpoints, one header set,
 * a timeout, and errors that carry Notion's own message (its 400s say
 * exactly which property is wrong, which is what the desk writes into the
 * row's Note). The token is passed in per call — it is the owner's, held
 * encrypted by lib/notion-desk-server.ts and decrypted only for the call.
 */
import { NOTION_VERSION } from '@/lib/notion-desk'

export const NOTION_TIMEOUT_MS = 15_000
const BASE = 'https://api.notion.com/v1'

export class NotionError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message)
  }
}

async function call<T>(token: string, method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<T> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), NOTION_TIMEOUT_MS)
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    })
    const json = (await res.json().catch(() => null)) as { code?: string; message?: string } | null
    if (!res.ok) {
      throw new NotionError(res.status, json?.code ?? `http_${res.status}`, json?.message ?? `Notion returned ${res.status}`)
    }
    return json as T
  } finally {
    clearTimeout(timer)
  }
}

export type NotionDatabase = {
  id: string
  title?: { plain_text?: string }[]
  properties: Record<string, { type: string }>
}

export const getDatabase = (token: string, databaseId: string) => call<NotionDatabase>(token, 'GET', `/databases/${databaseId}`)

export async function queryDatabase<T = unknown>(
  token: string,
  databaseId: string,
  filter: unknown,
  pageSize = 25,
): Promise<T[]> {
  const r = await call<{ results: T[] }>(token, 'POST', `/databases/${databaseId}/query`, { filter, page_size: pageSize })
  return r.results ?? []
}

export const updatePage = (token: string, pageId: string, properties: Record<string, unknown>) =>
  call<unknown>(token, 'PATCH', `/pages/${pageId}`, { properties })

export const appendBlocks = (token: string, pageId: string, children: unknown[]) =>
  call<unknown>(token, 'PATCH', `/blocks/${pageId}/children`, { children })

export const databaseTitle = (db: NotionDatabase): string | null => {
  const t = (db.title ?? []).map((x) => x.plain_text ?? '').join('').trim()
  return t || null
}
