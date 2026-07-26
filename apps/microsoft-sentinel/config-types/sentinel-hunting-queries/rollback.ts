import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildSentinelClient, armErrorMessage, SAVED_SEARCH_API_VERSION } from '../../lib/sentinel'
import type { SavedSearchRollbackEntry } from './deploy'

/**
 * Roll back hunting queries / saved searches using the state captured during
 * deploy: saved searches this deploy created are deleted; those it updated are
 * restored to their prior properties via an unconditional PUT (etag "*" so the
 * override succeeds regardless of the current etag).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildSentinelClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: SavedSearchRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []
  try {
    for (const entry of [...previousState].reverse()) {
      const path = client.workspaceChildPath(`/savedSearches/${entry.savedSearchId}`)
      if (!entry.existed) {
        const res = await client.request('DELETE', path, { apiVersion: SAVED_SEARCH_API_VERSION })
        if (res.status !== 404 && !res.ok) {
          throw new Error(`Failed to delete saved search "${entry.name}": ${armErrorMessage(res)}`)
        }
      } else if (entry.prior?.properties) {
        const p = entry.prior.properties
        const properties: Record<string, unknown> = {
          category: p.category,
          displayName: p.displayName,
          query: p.query,
          version: p.version ?? 2,
        }
        if (p.functionAlias) properties.functionAlias = p.functionAlias
        if (p.functionParameters) properties.functionParameters = p.functionParameters
        const res = await client.request('PUT', path, { apiVersion: SAVED_SEARCH_API_VERSION, body: { etag: '*', properties } })
        if (!res.ok) throw new Error(`Failed to restore saved search "${entry.name}": ${armErrorMessage(res)}`)
      }
      reverted.push(entry.name)
    }
    return { success: true, message: `Rolled back ${reverted.length} hunting query(ies): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}
