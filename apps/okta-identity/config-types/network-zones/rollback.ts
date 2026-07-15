import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient, oktaErrorMessage } from '../../lib/okta'
import { getZoneById, reconcileZoneStatus, type ZoneRollbackEntry } from './deploy'

/**
 * Roll back network zones using the state captured during deploy:
 *   - zones this deploy CREATED are deleted. On Okta Identity Engine an ACTIVE
 *     zone CANNOT be deleted, so each is DEACTIVATED first, then deleted. A
 *     delete also fails while a policy or policy rule still references the zone —
 *     that error is surfaced clearly so the operator can remove the reference.
 *   - zones this deploy UPDATED are PUT back to their captured prior definition,
 *     then returned to their prior lifecycle status.
 *
 * Rollback is keyed on the zone id Okta returned, never on the name.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: ZoneRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        // Deploy created this zone — remove it. DEACTIVATE FIRST: Okta refuses to
        // delete an ACTIVE zone. A 404/400 on deactivate means it is already gone
        // or already inactive, which is fine; then delete (404 = already deleted).
        if (entry.id) {
          const deactivate = await client.request('POST', `/zones/${entry.id}/lifecycle/deactivate`)
          if (!deactivate.ok && deactivate.status !== 404 && deactivate.status !== 400) {
            throw new Error(
              `Failed to deactivate zone "${entry.name}" before delete: ${oktaErrorMessage(deactivate)}`,
            )
          }
          const del = await client.request('DELETE', `/zones/${entry.id}`)
          if (!del.ok && del.status !== 404) {
            throw new Error(
              `Failed to delete zone "${entry.name}": ${oktaErrorMessage(del)}. Okta will not delete a zone that is still referenced by a policy or policy rule — remove those references first, then retry the rollback.`,
            )
          }
        }
      } else if (entry.id && entry.prior) {
        // Deploy updated this zone — restore its captured prior definition, then
        // restore its prior lifecycle status via the lifecycle endpoints.
        const res = await client.request('PUT', `/zones/${entry.id}`, { body: entry.prior })
        if (!res.ok) {
          throw new Error(`Failed to restore zone "${entry.name}": ${oktaErrorMessage(res)}`)
        }
        const live = await getZoneById(client, entry.id)
        await reconcileZoneStatus(client, entry.id, live?.status, entry.priorStatus)
      }

      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} network zone(s): ${reverted.join(', ')}. Zones created by the deployment were deactivated before deletion (Okta cannot delete an active zone).`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} zone(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
