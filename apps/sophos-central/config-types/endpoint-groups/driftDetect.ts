import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildSophosClient } from '../../lib/sophosCentral'
import { listEndpointGroups, listGroupEndpointIds, type SophosEndpointGroup } from '../../lib/sophosApi'
import { endpointGroupDetailsMatch, endpointGroupKey, endpointGroupMembershipMatches, extractEndpointGroupSpecs } from './_shared'

/**
 * Detect drift for endpoint groups: for each declared name, find the live
 * group and compare description and membership. A declared group that no
 * longer exists is critical drift; a changed description or membership set
 * is a warning.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildSophosClient(ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const specs = extractEndpointGroupSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  let live: SophosEndpointGroup[]
  try {
    live = await listEndpointGroups(client)
  } catch {
    return { hasDrift: false, diffs: [] }
  }
  const liveByName = new Map(live.filter((g) => g.name).map((g) => [endpointGroupKey(g.name), g] as const))

  for (const spec of specs) {
    const match = liveByName.get(endpointGroupKey(spec.name))
    if (!match) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'missing', severity: 'critical' })
      continue
    }
    if (!endpointGroupDetailsMatch(spec, match)) {
      diffs.push({
        field: `${spec.name}.description`,
        expected: spec.description,
        actual: match.description ?? '',
        severity: 'warning',
      })
    }
    if (match.id) {
      try {
        const liveMembers = await listGroupEndpointIds(client, match.id)
        if (!endpointGroupMembershipMatches(spec, liveMembers)) {
          diffs.push({
            field: `${spec.name}.endpointIds`,
            expected: [...spec.endpointIds].sort(),
            actual: [...liveMembers].sort(),
            severity: 'warning',
          })
        }
      } catch {
        // Best-effort: an unreadable membership list raises no false drift.
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
