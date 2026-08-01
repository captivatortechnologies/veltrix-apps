import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildJumpCloudClient, JUMPCLOUD_API_BASE } from '../../lib/jumpcloudApi'
import { listUserGroups, findGroupByName, listMemberIds, listSystemUsers } from './deploy'
import { extractMembershipSpecs, buildUserIndex, resolveMemberId } from './_shared'

/**
 * Detect drift between the deployed group membership and the live org. Resolves
 * each declared member to a user id and compares against the group's live members:
 *   - a declared member that is NOT in the group is drift (warning),
 *   - in exclusive mode, a live member that is NOT declared is drift (warning).
 * A missing target group is critical drift; an unresolved member is reported as
 * info rather than failing the check.
 *
 * Best-effort: if the org can't be read the check reports no drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildJumpCloudClient(ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built
  const builtV1 = buildJumpCloudClient(ctx.credential, ctx.settings, { baseUrl: JUMPCLOUD_API_BASE })
  if ('error' in builtV1) return { hasDrift: false, diffs }

  const specs = extractMembershipSpecs(ctx.deployedConfig).filter((s) => s.groupName)

  let groups
  let index
  try {
    groups = await listUserGroups(client)
    index = buildUserIndex(await listSystemUsers(builtV1.client))
  } catch {
    return { hasDrift: false, diffs } // best-effort
  }

  for (const spec of specs) {
    const group = findGroupByName(groups, spec.groupName)
    if (!group?.id) {
      diffs.push({ field: spec.groupName, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }

    const desired = new Set<string>()
    for (const member of spec.members) {
      const id = resolveMemberId(member, index)
      if (id) desired.add(id)
      else diffs.push({ field: `${spec.groupName}.member`, expected: member, actual: 'unresolved', severity: 'info' })
    }

    let current: Set<string>
    try {
      current = new Set(await listMemberIds(client, group.id))
    } catch {
      continue // can't read this group's members — assert nothing for it
    }

    for (const id of desired) {
      if (!current.has(id)) {
        diffs.push({ field: `${spec.groupName}.members`, expected: `${id} present`, actual: 'not a member', severity: 'warning' })
      }
    }
    if (spec.exclusive) {
      for (const id of current) {
        if (!desired.has(id)) {
          diffs.push({ field: `${spec.groupName}.members`, expected: `${id} absent`, actual: 'extra member', severity: 'warning' })
        }
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
