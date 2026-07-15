import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildZscalerClient, zscalerErrorMessage } from '../../lib/zscaler'
import type { ServiceEdgeGroupRollbackEntry } from './deploy'

/**
 * Roll back ZPA service edge groups using the state captured during deploy:
 *   - groups that were created are deleted (DELETE /serviceEdgeGroup/{id})
 *   - groups that were updated are restored (PUT) to their prior body
 * ZPA changes are immediate, so no activation is needed. Deleting a service edge
 * group that still has Private Service Edges or provisioning keys bound to it
 * will fail — reverse-order and the pipeline's dependency ordering keep
 * referrers gone first.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: ServiceEdgeGroupRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id != null) {
          const res = await client.zpa('DELETE', `/serviceEdgeGroup/${entry.id}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete service edge group "${entry.name}": ${zscalerErrorMessage(res)}`)
          }
        }
      } else if (entry.id != null && entry.prior) {
        const p = entry.prior
        const restore: Record<string, unknown> = {
          id: entry.id,
          name: p.name ?? entry.name,
          description: p.description ?? '',
          enabled: p.enabled ?? true,
          location: p.location ?? '',
          latitude: p.latitude ?? '',
          longitude: p.longitude ?? '',
          countryCode: p.countryCode ?? '',
          versionProfileId: p.versionProfileId ?? '0',
          upgradeDay: p.upgradeDay ?? 'SUNDAY',
          upgradeTimeInSecs: p.upgradeTimeInSecs ?? '66600',
        }
        const res = await client.zpa('PUT', `/serviceEdgeGroup/${entry.id}`, { body: restore })
        if (!res.ok) {
          throw new Error(`Failed to restore service edge group "${entry.name}": ${zscalerErrorMessage(res)}`)
        }
      }
      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} ZPA service edge group(s): ${reverted.join(', ')}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} group(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
