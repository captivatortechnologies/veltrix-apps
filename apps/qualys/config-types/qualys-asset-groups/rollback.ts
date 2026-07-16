import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildQualysClient, qualysWriteError, type QualysParams } from '../../lib/qualys'
import { ASSET_GROUP_PATH, type AssetGroupRollbackEntry } from './deploy'

/**
 * Roll back asset groups using the state captured during deploy:
 *   - groups that were created are deleted (action=delete)
 *   - groups that were updated are restored (action=edit) to their prior fields
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildQualysClient(ctx.component.hostname, ctx.credential, ctx.settings)
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
        if (entry.id) {
          const res = await client.post(ASSET_GROUP_PATH, { action: 'delete', id: entry.id })
          const failed = qualysWriteError(res)
          // A 404 / already-deleted group is not a rollback failure.
          if (failed && res.status !== 404) {
            throw new Error(`Failed to delete asset group "${entry.label}": ${failed}`)
          }
        }
      } else if (entry.id && entry.prior) {
        const p = entry.prior
        const params: QualysParams = {
          action: 'edit',
          id: entry.id,
          set_title: p.title,
          set_comments: p.comments,
        }
        if (p.businessImpact) params.set_business_impact = p.businessImpact
        if (p.ips.length > 0) params.set_ips = p.ips.join(',')
        const res = await client.post(ASSET_GROUP_PATH, params)
        const failed = qualysWriteError(res)
        if (failed) throw new Error(`Failed to restore asset group "${entry.label}": ${failed}`)
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
