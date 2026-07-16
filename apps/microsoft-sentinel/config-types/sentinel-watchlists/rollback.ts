import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildSentinelClient, armErrorMessage, SENTINEL_API_VERSION } from '../../lib/sentinel'
import type { WatchlistRollbackEntry } from './deploy'

/**
 * Roll back watchlists using the state captured during deploy: watchlists this
 * deploy created are deleted; watchlists it updated are restored to their prior
 * metadata (display name, provider, search key). Item content cannot be restored
 * because GET does not return rawContent — this restores metadata only.
 * Watchlist DELETE/PUT are asynchronous, so each is followed by a bounded poll.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildSentinelClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: WatchlistRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []
  try {
    for (const entry of [...previousState].reverse()) {
      const path = client.sentinelPath(`/watchlists/${entry.alias}`)
      if (!entry.existed) {
        const res = await client.request('DELETE', path, { apiVersion: SENTINEL_API_VERSION })
        if (res.status !== 404 && !res.ok) {
          throw new Error(`Failed to delete watchlist "${entry.alias}": ${armErrorMessage(res)}`)
        }
        // DELETE is asynchronous — wait for the resource to disappear.
        await client.pollProvisioning(path, SENTINEL_API_VERSION)
      } else if (entry.prior?.properties) {
        const p = entry.prior.properties
        const body = {
          properties: {
            displayName: p.displayName,
            provider: p.provider,
            source: p.source ?? `${entry.alias}.csv`,
            sourceType: p.sourceType ?? 'Local',
            itemsSearchKey: p.itemsSearchKey,
            numberOfLinesToSkip: p.numberOfLinesToSkip ?? 0,
          },
        }
        const res = await client.request('PUT', path, { apiVersion: SENTINEL_API_VERSION, body })
        if (!res.ok) throw new Error(`Failed to restore watchlist "${entry.alias}": ${armErrorMessage(res)}`)
        await client.pollProvisioning(path, SENTINEL_API_VERSION)
      }
      reverted.push(entry.alias)
    }
    return { success: true, message: `Rolled back ${reverted.length} watchlist(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}
