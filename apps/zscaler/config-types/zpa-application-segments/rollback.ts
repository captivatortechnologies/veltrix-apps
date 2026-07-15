import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildZscalerClient, zscalerErrorMessage } from '../../lib/zscaler'
import type { ApplicationSegmentRollbackEntry } from './deploy'

/**
 * Roll back ZPA application segments using the state captured during deploy:
 *   - segments that were created are deleted (DELETE /application/{id})
 *   - segments that were updated are restored (PUT) to their prior body
 * ZPA changes are immediate, so no activation is needed. Restoring in reverse
 * order undoes the most recent writes first.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: ApplicationSegmentRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id != null) {
          const res = await client.zpa('DELETE', `/application/${entry.id}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete application segment "${entry.name}": ${zscalerErrorMessage(res)}`)
          }
        }
      } else if (entry.id != null && entry.prior) {
        const restore: Record<string, unknown> = {
          id: entry.id,
          name: entry.prior.name ?? entry.name,
          description: entry.prior.description ?? '',
          enabled: entry.prior.enabled ?? true,
          domainNames: entry.prior.domainNames ?? [],
          segmentGroupId: entry.prior.segmentGroupId,
          serverGroups: entry.prior.serverGroups ?? [],
          tcpPortRange: entry.prior.tcpPortRange ?? [],
          udpPortRange: entry.prior.udpPortRange ?? [],
          bypassType: entry.prior.bypassType,
          healthReporting: entry.prior.healthReporting,
        }
        const res = await client.zpa('PUT', `/application/${entry.id}`, { body: restore })
        if (!res.ok) {
          throw new Error(`Failed to restore application segment "${entry.name}": ${zscalerErrorMessage(res)}`)
        }
      }
      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} ZPA application segment(s): ${reverted.join(', ')}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} segment(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
