import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildJumpCloudClient } from '../../lib/jumpcloudApi'
import { listPolicyGroups, listPoliciesForResolution, listMemberIds } from './deploy'
import { extractPolicyGroupSpecs, findPolicyGroupByName, findPolicyRefByName } from './_shared'

/**
 * Detect drift between the deployed Policy Group configuration and the live org.
 * Re-finds each declared group by name and diffs its exclusive member Policy set.
 * A missing target group is critical drift; an unresolved member Policy name is
 * reported as info rather than failing the check.
 *
 * Best-effort: if the org can't be read the check reports no drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildJumpCloudClient(ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const specs = extractPolicyGroupSpecs(ctx.deployedConfig).filter((s) => s.name)

  let liveGroups
  let livePolicies
  try {
    liveGroups = await listPolicyGroups(client)
    livePolicies = await listPoliciesForResolution(client)
  } catch {
    return { hasDrift: false, diffs } // best-effort
  }

  for (const spec of specs) {
    const group = findPolicyGroupByName(liveGroups, spec.name)
    if (!group?.id) {
      diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }

    const desired = new Set<string>()
    for (const name of spec.memberPolicies) {
      const match = findPolicyRefByName(livePolicies, name)
      if (match?.id) desired.add(match.id)
      else diffs.push({ field: `${spec.name}.memberPolicies`, expected: name, actual: 'unresolved', severity: 'info' })
    }

    let current: Set<string>
    try {
      current = new Set(await listMemberIds(client, group.id))
    } catch {
      continue // can't read this group's members — assert nothing for it
    }

    for (const id of desired) {
      if (!current.has(id)) {
        diffs.push({ field: `${spec.name}.memberPolicies`, expected: `${id} present`, actual: 'not a member', severity: 'warning' })
      }
    }
    for (const id of current) {
      if (!desired.has(id)) {
        diffs.push({ field: `${spec.name}.memberPolicies`, expected: `${id} absent`, actual: 'extra member', severity: 'warning' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
