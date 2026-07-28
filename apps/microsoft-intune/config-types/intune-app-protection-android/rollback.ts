import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildIntuneClient, graphErrorMessage, type IntuneClient } from '../../lib/intune'
import {
  ANDROID_APP_PROTECTION_PATH,
  buildAssignments,
  buildRestoreBody,
  buildTargetApps,
  type AppGroupType,
} from './appProtection'
import type { ProtectionRollbackEntry } from './deploy'

/**
 * Roll back Android app protection policies using the state captured during deploy:
 * policies this deploy created are deleted; policies it updated are restored to
 * their prior fields and re-converged to their prior targeted apps and assignments.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildIntuneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: ProtectionRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []
  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.request('DELETE', `${ANDROID_APP_PROTECTION_PATH}/${entry.id}`)
          if (res.status !== 404 && !res.ok) throw new Error(`Failed to delete app protection policy "${entry.name}": ${graphErrorMessage(res)}`)
        }
      } else if (entry.id && entry.prior) {
        const res = await client.request('PATCH', `${ANDROID_APP_PROTECTION_PATH}/${entry.id}`, {
          body: buildRestoreBody(entry.prior.fields),
        })
        if (!res.ok) throw new Error(`Failed to restore app protection policy "${entry.name}": ${graphErrorMessage(res)}`)
        await restoreTargetApps(client, entry.id, entry.name, entry.prior.appGroupType, entry.prior.targetedApps)
        // Only restore assignments if THIS deploy managed them (else leave live/manual ones).
        if (entry.managedAssignments) await restoreAssignment(client, entry.id, entry.name, entry.prior.assignment)
      }
      reverted.push(entry.name)
    }
    return { success: true, message: `Rolled back ${reverted.length} app protection policy(ies): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}

async function restoreTargetApps(
  client: IntuneClient,
  id: string,
  name: string,
  appGroupType: AppGroupType,
  targetedApps: string[],
): Promise<void> {
  const res = await client.request('POST', `${ANDROID_APP_PROTECTION_PATH}/${id}/targetApps`, {
    body: buildTargetApps({ platform: 'android', appIds: targetedApps, appGroupType }),
  })
  if (!res.ok) throw new Error(`Failed to restore targeted apps for "${name}": ${graphErrorMessage(res)}`)
}

async function restoreAssignment(
  client: IntuneClient,
  id: string,
  name: string,
  assignment: NonNullable<ProtectionRollbackEntry['prior']>['assignment'],
): Promise<void> {
  const res = await client.request('POST', `${ANDROID_APP_PROTECTION_PATH}/${id}/assign`, {
    body: { assignments: buildAssignments(assignment) },
  })
  if (!res.ok) throw new Error(`Failed to re-assign app protection policy "${name}": ${graphErrorMessage(res)}`)
}
