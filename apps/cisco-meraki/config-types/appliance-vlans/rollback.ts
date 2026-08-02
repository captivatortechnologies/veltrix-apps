import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildMerakiClient, deleteVlan, updateVlan } from '../../lib/merakiApi'
import { restoreVlanBody } from './_shared'
import type { VlanRollbackEntry } from './deploy'

/**
 * Roll back VLANs using the state captured during deploy:
 *   - VLANs that were created are deleted (DELETE .../appliance/vlans/{id})
 *   - VLANs that were updated are restored to their captured prior body
 *     (PUT .../appliance/vlans/{id})
 *
 * Meraki may refuse to delete a network's last remaining VLAN while VLANs
 * are enabled (unverified in the current docs beyond the endpoint's own 400 —
 * see README); that failure surfaces as a rollback error rather than being
 * worked around.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildMerakiClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previous = (ctx.rollbackData as { previous?: VlanRollbackEntry[] } | undefined)?.previous
  if (!previous || previous.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previous].reverse()) {
      const label = `${entry.networkId}/${entry.id}`
      if (!entry.existed) {
        await deleteVlan(client, entry.networkId, entry.id)
      } else if (entry.prior) {
        await updateVlan(client, entry.networkId, entry.id, restoreVlanBody(entry.prior))
      }
      reverted.push(label)
    }
    return { success: true, message: `Rolled back ${reverted.length} VLAN(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previous.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}
