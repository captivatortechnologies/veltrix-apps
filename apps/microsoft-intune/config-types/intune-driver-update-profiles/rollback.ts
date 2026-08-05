import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildIntuneClient, graphErrorMessage } from '../../lib/intune'
import { assignProfile, DRIVER_UPDATE_PROFILES_PATH, type ProfileRollbackEntry } from './deploy'
import { DRIVER_UPDATE_PROFILE_ODATA_TYPE } from './validate'

/**
 * Roll back driver update profiles using the state captured during deploy:
 * profiles this deploy created are deleted; profiles it updated are restored to
 * their prior description / approval type / deferral (and prior assignments,
 * when this deploy managed them).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildIntuneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: ProfileRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []
  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.request('DELETE', `${DRIVER_UPDATE_PROFILES_PATH}/${entry.id}`)
          if (res.status !== 404 && !res.ok) throw new Error(`Failed to delete driver update profile "${entry.name}": ${graphErrorMessage(res)}`)
        }
      } else if (entry.id && entry.prior) {
        const body: Record<string, unknown> = {
          '@odata.type': DRIVER_UPDATE_PROFILE_ODATA_TYPE,
          displayName: entry.name,
          description: entry.prior.description ?? '',
          roleScopeTagIds: ['0'],
          approvalType: entry.prior.approvalType ?? 'manual',
        }
        if (entry.prior.approvalType === 'automatic' && entry.prior.deploymentDeferralInDays !== undefined) {
          body.deploymentDeferralInDays = entry.prior.deploymentDeferralInDays
        }
        const res = await client.request('PATCH', `${DRIVER_UPDATE_PROFILES_PATH}/${entry.id}`, { body })
        if (!res.ok) throw new Error(`Failed to restore driver update profile "${entry.name}": ${graphErrorMessage(res)}`)
        if (entry.managedAssignments && entry.prior.assignments) {
          await assignProfile(client, entry.id, entry.prior.assignments, entry.name)
        }
      }
      reverted.push(entry.name)
    }
    return { success: true, message: `Rolled back ${reverted.length} driver update profile(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}
