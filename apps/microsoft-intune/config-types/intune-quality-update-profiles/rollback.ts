import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildIntuneClient, graphErrorMessage } from '../../lib/intune'
import { assignProfile, QUALITY_UPDATE_PROFILES_PATH, type ProfileRollbackEntry } from './deploy'
import { EXPEDITED_SETTINGS_ODATA_TYPE, QUALITY_UPDATE_PROFILE_ODATA_TYPE } from './validate'

/**
 * Roll back quality update profiles using the state captured during deploy:
 * profiles this deploy created are deleted; profiles it updated are restored to
 * their prior description / expedited settings (and prior assignments, when this
 * deploy managed them).
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
          const res = await client.request('DELETE', `${QUALITY_UPDATE_PROFILES_PATH}/${entry.id}`)
          if (res.status !== 404 && !res.ok) throw new Error(`Failed to delete quality update profile "${entry.name}": ${graphErrorMessage(res)}`)
        }
      } else if (entry.id && entry.prior) {
        const body: Record<string, unknown> = {
          '@odata.type': QUALITY_UPDATE_PROFILE_ODATA_TYPE,
          displayName: entry.name,
          description: entry.prior.description ?? '',
          roleScopeTagIds: ['0'],
        }
        if (entry.prior.expeditedUpdateSettings) {
          body.expeditedUpdateSettings = {
            '@odata.type': EXPEDITED_SETTINGS_ODATA_TYPE,
            ...entry.prior.expeditedUpdateSettings,
          }
        }
        const res = await client.request('PATCH', `${QUALITY_UPDATE_PROFILES_PATH}/${entry.id}`, { body })
        if (!res.ok) throw new Error(`Failed to restore quality update profile "${entry.name}": ${graphErrorMessage(res)}`)
        if (entry.managedAssignments && entry.prior.assignments) {
          await assignProfile(client, entry.id, entry.prior.assignments, entry.name)
        }
      }
      reverted.push(entry.name)
    }
    return { success: true, message: `Rolled back ${reverted.length} quality update profile(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}
