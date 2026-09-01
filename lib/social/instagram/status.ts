/**
 * Read-side: what a container or a published media is up to.
 * Container status itself lives in containers.ts (the poll loop needs it);
 * this file is the post-publish read used to verify and to build permalinks.
 */
import { igFetch } from './client'
import type { InstagramConfig, PublishedMedia, RequestOptions } from './types'

export { getContainerStatus, waitForContainer } from './containers'

export async function getMedia(
  config: InstagramConfig,
  mediaId: string,
  options?: RequestOptions,
): Promise<PublishedMedia> {
  const res = await igFetch<{ id: string; permalink?: string; media_type?: string; timestamp?: string }>(
    config,
    mediaId,
    { params: { fields: 'id,permalink,media_type,timestamp' } },
    options,
  )
  return { id: res.id, permalink: res.permalink, mediaType: res.media_type, timestamp: res.timestamp }
}
