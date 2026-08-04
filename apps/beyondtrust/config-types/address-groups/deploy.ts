import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildPasswordSafeUrl, deletePath, getJson, sendJson, withSession } from '../../lib/beyondtrustApi'
import {
  declaredAddresses,
  diffAddresses,
  findAddressGroupByName,
  listFrom,
  str,
  type AddressEntry,
  type AddressGroup,
} from './_shared'

/**
 * Deploy Password Safe address groups over the BeyondInsight REST API inside a
 * PS-Auth session:
 *   read (identity): GET    /AddressGroups                       → match by name
 *   create:          POST   /AddressGroups                       { Name }
 *   read members:    GET    /AddressGroups/{id}/Addresses
 *   add member:      POST   /AddressGroups/{id}/Addresses         { IPAddress }
 *   remove member:   DELETE /Addresses/{id}
 *
 * Membership is AUTHORITATIVE: the declared address list is reconciled against
 * the live one every deploy (add what's missing, remove what's no longer
 * declared) — see _shared.ts for why this is safe here (no secret material,
 * full CRUD).
 *
 * rollbackData records, per group, whether WE created the group and exactly
 * which addresses we added/removed, so rollback can undo precisely that (see
 * rollback.ts).
 *
 * NOTE: verify /AddressGroups create + .../Addresses add/remove against a live
 * BeyondTrust instance.
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

async function listGroups(base: string, cookie: string): Promise<AddressGroup[]> {
  try {
    return listFrom<AddressGroup>(await getJson<unknown>(base, '/AddressGroups', cookie))
  } catch {
    return []
  }
}

async function listMembers(base: string, cookie: string, groupId: number | string): Promise<AddressEntry[]> {
  try {
    return listFrom<AddressEntry>(
      await getJson<unknown>(base, `/AddressGroups/${encodeURIComponent(String(groupId))}/Addresses`, cookie),
    )
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for address group deployment' }
  }

  const base = buildPasswordSafeUrl(component, connectivity, connectivityProvider)
  const previous: RollbackEntry[] = []
  const groupsCreated: string[] = []
  let addressesAdded = 0
  let addressesRemoved = 0

  try {
    await withSession(base, credential, async (cookie) => {
      const liveGroups = await listGroups(base, cookie)

      for (const item of items) {
        const name = str(item.fields.name)
        if (!name) continue
        const declared = declaredAddresses(item.fields.addresses)

        let group = findAddressGroupByName(liveGroups, name)
        let groupCreated = false
        if (!group) {
          group = await sendJson<AddressGroup>('POST', base, '/AddressGroups', cookie, { Name: name })
          groupCreated = true
          groupsCreated.push(name)
        }
        const groupId = group?.AddressGroupID
        if (groupId == null) {
          throw new Error(`Address group "${name}" has no id after create/lookup.`)
        }

        const members = groupCreated ? [] : await listMembers(base, cookie, groupId)
        const { toAdd, toRemove } = diffAddresses(declared, members)

        const added: AddedAddress[] = []
        for (const ipAddress of toAdd) {
          const res = await sendJson<AddressEntry>(
            'POST',
            base,
            `/AddressGroups/${encodeURIComponent(String(groupId))}/Addresses`,
            cookie,
            { IPAddress: ipAddress },
          )
          added.push({ ipAddress, addressId: res?.AddressID ?? null })
        }
        for (const entry of toRemove) {
          if (entry.AddressID == null) continue
          await deletePath(base, `/Addresses/${encodeURIComponent(String(entry.AddressID))}`, cookie)
        }

        addressesAdded += toAdd.length
        addressesRemoved += toRemove.length
        previous.push({
          name,
          groupId,
          groupCreated,
          added,
          removed: toRemove.map((e) => str(e.IPAddress)).filter(Boolean),
        })
      }
    })

    return {
      success: true,
      message: `Address groups: ${groupsCreated.length} created, ${addressesAdded} address(es) added, ${addressesRemoved} address(es) removed`,
      artifacts: { groupsCreated },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Address group deploy failed after ${groupsCreated.length} group(s) created: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { groupsCreated },
      rollbackData: { previous },
    }
  }
}
