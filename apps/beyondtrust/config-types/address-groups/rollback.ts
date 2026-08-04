import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildPasswordSafeUrl, deletePath, sendJson, withSession } from '../../lib/beyondtrustApi'

/**
 * Undo an address-groups deploy from rollbackData.previous (written by
 * deploy()):
 *   - a group WE created:      DELETE /AddressGroups/{id} (removes the group
 *                               and any remaining membership with it)
 *   - a group that pre-existed: DELETE /Addresses/{addressId} for every address
 *                               WE added, and re-POST /AddressGroups/{id}/Addresses
 *                               for every address WE removed (restore)
 *
 * A delete or restore that fails — e.g. the group or address is now referenced
 * elsewhere — is skipped rather than failing the whole rollback. Applied over
 * the BeyondInsight REST API inside a PS-Auth session.
 *
 * NOTE: verify DELETE /AddressGroups/{id}, DELETE /Addresses/{id} and
 * POST /AddressGroups/{id}/Addresses against a live BeyondTrust instance.
 */
interface AddedAddress {
  ipAddress: string
  addressId: number | string | null
}

interface RollbackEntry {
  name: string
  groupId: number | string | null
  groupCreated: boolean
  added: AddedAddress[]
  removed: string[]
}

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: RollbackEntry[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for address group rollback' }
  }

  const base = buildPasswordSafeUrl(component, connectivity, connectivityProvider)
  let groupsDeleted = 0
  let addressesRemoved = 0
  let addressesRestored = 0
  let skipped = 0

  try {
    await withSession(base, credential, async (cookie) => {
      for (const entry of previous) {
        if (entry.groupId == null) {
          skipped++
          continue
        }

        if (entry.groupCreated) {
          try {
            await deletePath(base, `/AddressGroups/${encodeURIComponent(String(entry.groupId))}`, cookie)
            groupsDeleted++
          } catch {
            skipped++
          }
          continue
        }

        for (const added of entry.added) {
          if (added.addressId == null) {
            skipped++
            continue
          }
          try {
            await deletePath(base, `/Addresses/${encodeURIComponent(String(added.addressId))}`, cookie)
            addressesRemoved++
          } catch {
            skipped++
          }
        }
        for (const ipAddress of entry.removed) {
          try {
            await sendJson('POST', base, `/AddressGroups/${encodeURIComponent(String(entry.groupId))}/Addresses`, cookie, { IPAddress: ipAddress })
            addressesRestored++
          } catch {
            skipped++
          }
        }
      }
    })
    return {
      success: true,
      message:
        `Rolled back address groups: ${groupsDeleted} group(s) deleted, ${addressesRemoved} address(es) removed, ` +
        `${addressesRestored} address(es) restored${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
