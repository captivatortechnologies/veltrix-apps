import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildSecretServerClient, secretServerErrorMessage } from '../../lib/secretServerApi'
import { buildIpRestrictionRestoreBody } from './_shared'
import type { IpRestrictionRollbackEntry } from './deploy'

/**
 * Undo an ip-address-restrictions deploy from rollbackData.previous (written
 * by deploy()): for each restriction that already existed, PUT
 * /ipaddress-restrictions/{id} to restore its prior body; a newly created
 * restriction (existed=false) is left in place — this app does not delete
 * restrictions. Applied over the Secret Server REST API.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const data = (ctx.rollbackData ?? {}) as { previous?: IpRestrictionRollbackEntry[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  const built = buildSecretServerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  let restored = 0
  let left = 0
  try {
    for (const entry of previous) {
      if (!entry.existed || !entry.prior || entry.restrictionId === null) {
        // A newly created restriction (or one whose id we never learned) — leave it in place.
        left++
        continue
      }
      const res = await client.request('PUT', `/ipaddress-restrictions/${entry.restrictionId}`, { body: buildIpRestrictionRestoreBody(entry.prior) })
      if (!res.ok) throw new Error(`Failed to restore IP address restriction "${entry.name}": ${secretServerErrorMessage(res)}`)
      restored++
    }
    return { success: true, message: `Rolled back IP address restrictions: ${restored} restored${left ? `, ${left} left in place` : ''}.` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
