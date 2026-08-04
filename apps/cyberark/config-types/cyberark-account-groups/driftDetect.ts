import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildCyberArkClient } from '../../lib/cyberark'
import { findAccount } from '../cyberark-accounts/deploy'
import { listGroupMemberIds, mapGroupsBySafe } from './deploy'
import { extractAccountGroupSpecs, groupKey, parseMembers, type LiveAccountGroup } from './validate'

/**
 * Detect drift between the deployed account-group configuration and the live
 * PVWA. Re-finds each declared group by (safe, name) and diffs membership; a
 * missing group is critical drift. GroupPlatformID drift is reported
 * informationally only — there is no verified update endpoint for it.
 *
 * Account groups carry no creator/modifier metadata over this API, so diffs
 * are reported without an actor.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildCyberArkClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractAccountGroupSpecs(ctx.deployedConfig).filter((s) => s.groupName && s.safeName)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const bySafe = new Map<string, Map<string, LiveAccountGroup>>()

    for (const spec of specs) {
      const label = `${spec.groupName} @ ${spec.safeName}`
      const safeLower = spec.safeName.toLowerCase()
      if (!bySafe.has(safeLower)) bySafe.set(safeLower, await mapGroupsBySafe(client, spec.safeName))
      const found = bySafe.get(safeLower)?.get(spec.groupName.toLowerCase())

      if (!found) {
        diffs.push({ field: groupKey(spec), expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      if (found.GroupPlatformID && found.GroupPlatformID !== spec.groupPlatformId) {
        diffs.push({
          field: `${label}.group_platform_id (not auto-correctable — no update endpoint)`,
          expected: spec.groupPlatformId,
          actual: found.GroupPlatformID,
          severity: 'info',
        })
      }

      if (found.GroupID === undefined) continue
      const groupId = String(found.GroupID)
      const liveIds = new Set(await listGroupMemberIds(client, groupId))
      const members = parseMembers(spec.membersJson).value ?? []
      for (const member of members) {
        const account = await findAccount(client, { name: member.accountName, safeName: member.safeName })
        const present = !!account?.id && liveIds.has(account.id)
        if (!present) {
          diffs.push({ field: `${label}.members`, expected: `${member.accountName} @ ${member.safeName}`, actual: 'missing', severity: 'warning' })
        }
      }
    }
  } catch (error) {
    diffs.push({
      field: 'cyberark',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  await client.logoff()
  return { hasDrift: diffs.length > 0, diffs }
}
