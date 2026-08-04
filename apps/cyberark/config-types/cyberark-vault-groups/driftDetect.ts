import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildCyberArkClient } from '../../lib/cyberark'
import { listGroupMembers, mapGroups } from './deploy'
import { groupMemberKey, extractVaultGroupSpecs, parseGroupMembers, vaultGroupKey, type LiveGroupMember } from './validate'

/**
 * Detect drift between the deployed Vault-group configuration and the live
 * PVWA. Re-finds each declared group by name and diffs description/location
 * + membership; a missing group is critical drift.
 *
 * Vault groups carry no creator/modifier metadata over this API, so diffs
 * are reported without an actor.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildCyberArkClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractVaultGroupSpecs(ctx.deployedConfig).filter((s) => s.groupName)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const byKey = await mapGroups(client)

    for (const spec of specs) {
      const found = byKey.get(vaultGroupKey(spec))
      if (!found) {
        diffs.push({ field: spec.groupName, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }
      if ((found.description ?? '') !== spec.description) {
        diffs.push({ field: `${spec.groupName}.description`, expected: spec.description || '(empty)', actual: found.description ?? 'not set', severity: 'info' })
      }
      if ((found.location ?? '\\') !== spec.location) {
        diffs.push({ field: `${spec.groupName}.location`, expected: spec.location, actual: found.location ?? 'not set', severity: 'info' })
      }

      if (found.id === undefined) continue
      const liveMembers: LiveGroupMember[] = await listGroupMembers(client, String(found.id))
      const liveSignatures = new Set(liveMembers.map((m) => groupMemberKey({ memberId: m.username ?? m.memberId ?? '', memberType: m.memberType ?? 'vault' })))
      const members = parseGroupMembers(spec.membersJson).value ?? []
      for (const m of members) {
        if (!liveSignatures.has(groupMemberKey(m))) {
          diffs.push({ field: `${spec.groupName}.members`, expected: m.memberId, actual: 'missing', severity: 'warning' })
        }
      }
      const desiredSignatures = new Set(members.map((m) => groupMemberKey(m)))
      for (const m of liveMembers) {
        const sig = groupMemberKey({ memberId: m.username ?? m.memberId ?? '', memberType: m.memberType ?? 'vault' })
        if (!desiredSignatures.has(sig)) {
          diffs.push({ field: `${spec.groupName}.members`, expected: 'not declared', actual: m.username ?? m.memberId ?? 'unknown', severity: 'warning' })
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
