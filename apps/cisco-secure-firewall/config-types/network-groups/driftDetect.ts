import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildFmcClient } from '../../lib/fmc'
import { buildNetworkObjectIndex, resolveRefs } from '../../lib/fmcRefs'
import { extractNetworkGroupSpecs, NETWORK_GROUPS_PATH } from './validate'

/**
 * Drift detection re-resolves each group's declared members against the
 * CURRENT network-object index (an object created after the group's last
 * deploy still counts) and compares the resulting id set against what FMC
 * reports live. Unresolved member names surface as their own diff rather
 * than silently comparing against an incomplete expected set.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const specs = extractNetworkGroupSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  const built = buildFmcClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built

  const [listed, index] = await Promise.all([client.list(NETWORK_GROUPS_PATH), buildNetworkObjectIndex(client)])
  if (!listed.ok) {
    return {
      hasDrift: true,
      diffs: [{ field: 'network-groups', expected: 'reachable', actual: `list failed (HTTP ${listed.status})`, severity: 'critical' }],
    }
  }

  const byName = new Map(listed.items.map((item) => [(item.name ?? '').toLowerCase(), item]))
  const diffs: DriftDiff[] = []

  for (const spec of specs) {
    const live = byName.get(spec.name.toLowerCase())
    if (!live) {
      diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }

    const { resolved, missing } = resolveRefs(index, spec.memberNames)
    if (missing.length > 0) {
      diffs.push({
        field: `${spec.name}.members`,
        expected: `all ${spec.memberNames.length} member(s) resolvable`,
        actual: `${missing.length} unresolved: ${missing.join(', ')}`,
        severity: 'warning',
      })
    }

    const expectedIds = resolved.map((r) => r.id).sort()
    const liveObjects = Array.isArray(live.objects) ? (live.objects as Array<{ id?: string }>) : []
    const liveIds = liveObjects.map((o) => o.id).filter((id): id is string => typeof id === 'string').sort()
    if (JSON.stringify(expectedIds) !== JSON.stringify(liveIds)) {
      diffs.push({
        field: `${spec.name}.members`,
        expected: `${expectedIds.length} member(s)`,
        actual: `${liveIds.length} member(s)`,
        severity: 'info',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
