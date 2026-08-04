import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildPasswordSafeUrl, getJson, withSession } from '../../lib/beyondtrustApi'
import { declaredAddresses, diffAddresses, findAddressGroupByName, listFrom, str, type AddressEntry, type AddressGroup } from './_shared'

/**
 * Drift for address groups: compare the declared address list against the
 * live group's membership in Password Safe. A declared group that is MISSING
 * is a warning; a present group whose membership differs (addresses to add or
 * remove) is ALSO a warning — membership is authoritative and fully
 * correctable by a redeploy (see deploy.ts). Best-effort and read-only:
 * GET /AddressGroups and GET /AddressGroups/{id}/Addresses inside a PS-Auth
 * session. Verify against a live BeyondTrust instance.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const base = buildPasswordSafeUrl(component, connectivity, connectivityProvider)

  let liveGroups: AddressGroup[]
  try {
    liveGroups = await withSession(base, credential, async (cookie) =>
      listFrom<AddressGroup>(await getJson<unknown>(base, '/AddressGroups', cookie)),
    )
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read groups, no drift asserted
  }

  for (const item of items) {
    const name = str(item.fields.name)
    if (!name) continue

    const group = findAddressGroupByName(liveGroups, name)
    if (!group?.AddressGroupID) {
      diffs.push({ field: name, expected: 'present', actual: 'missing', severity: 'warning' })
      continue
    }

    let members: AddressEntry[]
    try {
      members = await withSession(base, credential, async (cookie) =>
        listFrom<AddressEntry>(
          await getJson<unknown>(base, `/AddressGroups/${encodeURIComponent(String(group.AddressGroupID))}/Addresses`, cookie),
        ),
      )
    } catch {
      continue // best-effort: can't read this group's members, don't assert drift for it
    }

    const declared = declaredAddresses(item.fields.addresses)
    const { toAdd, toRemove } = diffAddresses(declared, members)

    if (toAdd.length) {
      diffs.push({ field: `${name}.addresses`, expected: `+${toAdd.join(', ')}`, actual: 'missing', severity: 'warning' })
    }
    if (toRemove.length) {
      const extra = toRemove.map((e) => str(e.IPAddress)).filter(Boolean)
      diffs.push({ field: `${name}.addresses`, expected: 'not declared', actual: extra.join(', '), severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
