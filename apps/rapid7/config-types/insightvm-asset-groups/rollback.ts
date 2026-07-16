import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildInsightVMClient, insightVMErrorMessage } from '../../lib/insightvm'
import type { AssetGroupRollbackEntry } from './deploy'

/**
 * Roll back asset groups using the state captured during deploy:
 *   - groups that were created are deleted (DELETE /asset_groups/{id})
 *   - groups that were updated are restored (PUT) to their prior body
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildInsightVMClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: AssetGroupRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id != null) {
          const res = await client.request('DELETE', `/asset_groups/${entry.id}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete asset group "${entry.label}": ${insightVMErrorMessage(res)}`)
          }
        }
      } else if (entry.id != null && entry.prior) {
        const p = entry.prior
        const restore: Record<string, unknown> = {
          name: p.name,
          description: p.description ?? '',
          type: p.type,
        }
        if (p.searchCriteria !== undefined) restore.searchCriteria = p.searchCriteria
        const res = await client.request('PUT', `/asset_groups/${entry.id}`, { body: restore })
        if (!res.ok) throw new Error(`Failed to restore asset group "${entry.label}": ${insightVMErrorMessage(res)}`)
      }
      reverted.push(entry.label)
    }

    return { success: true, message: `Rolled back ${reverted.length} asset group(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
