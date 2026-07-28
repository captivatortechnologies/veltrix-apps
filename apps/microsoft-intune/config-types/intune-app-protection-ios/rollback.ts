import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildIntuneClient, graphErrorMessage } from '../../lib/intune'
import { buildRestoreBody } from './iosAppProtection'
import { assignPolicy, targetApps, type IosMamRollbackEntry } from './deploy'

/**
 * Roll back iOS app protection policies using the state captured during deploy:
 * policies this deploy created are deleted; policies it updated are restored to
 * their prior scalar fields, prior targeted apps and prior assignment groups.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildIntuneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: IosMamRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []
  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.request('DELETE', `/deviceAppManagement/iosManagedAppProtections/${entry.id}`)
          if (res.status !== 404 && !res.ok) throw new Error(`Failed to delete app protection policy "${entry.name}": ${graphErrorMessage(res)}`)
        }
      } else if (entry.id && entry.prior) {
        const res = await client.request('PATCH', `/deviceAppManagement/iosManagedAppProtections/${entry.id}`, {
          body: buildRestoreBody(entry.name, entry.prior.description, entry.prior.fields),
        })
        if (!res.ok) throw new Error(`Failed to restore app protection policy "${entry.name}": ${graphErrorMessage(res)}`)
        await targetApps(client, entry.id, entry.prior.appGroupType, entry.prior.targetedApps, entry.name)
        await assignPolicy(client, entry.id, entry.prior.assignment, entry.name)
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
