import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildTwingateClient } from '../../lib/twingateApi'
import { listGroups, listResources } from './deploy'
import { extractGroupSpecs, groupKey, idSetSignature, isExternallyManaged, resourceIdsFromGroup, type NamedRef } from './_shared'

/**
 * Detect drift between the deployed Group configuration and the live
 * Twingate tenant. Re-finds each declared group by name (among MANUAL groups
 * only) and diffs `isActive` and Resource access; a missing group is critical
 * drift, as is a declared name that now only matches an externally-managed
 * (SYNCED/SYSTEM) group.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildTwingateClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractGroupSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listGroups(client)
    const byName = new Map(live.filter((g) => g.name).map((g) => [groupKey(g.name as string), g]))

    const needsResources = specs.some((s) => s.resourceNames.length > 0)
    const resourcesByName = needsResources ? indexByName(await listResources(client)) : new Map<string, NamedRef>()

    for (const spec of specs) {
      const label = spec.name
      const found = byName.get(groupKey(spec.name))

      if (!found || !found.id) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }
      if (isExternallyManaged(found.type)) {
        diffs.push({
          field: `${label}.name`,
          expected: 'a Veltrix-managed (MANUAL) group',
          actual: `now a ${found.type} group`,
          severity: 'critical',
        })
        continue
      }

      const liveActive = found.isActive ?? true
      if (liveActive !== spec.isActive) {
        diffs.push({ field: `${label}.is_active`, expected: String(spec.isActive), actual: String(liveActive), severity: 'warning' })
      }

      const missingResources = spec.resourceNames.filter((name) => !resourcesByName.get(groupKey(name))?.id)
      if (missingResources.length > 0) {
        diffs.push({
          field: `${label}.resource_names`,
          expected: spec.resourceNames.join(', '),
          actual: `not found in Twingate: ${missingResources.join(', ')}`,
          severity: 'warning',
        })
      } else {
        const declaredIds = spec.resourceNames
          .map((name) => resourcesByName.get(groupKey(name))?.id)
          .filter((id): id is string => typeof id === 'string' && id.length > 0)
        const liveIds = resourceIdsFromGroup(found)
        if (idSetSignature(declaredIds) !== idSetSignature(liveIds)) {
          diffs.push({
            field: `${label}.resource_names`,
            expected: `${declaredIds.length} resource(s)`,
            actual: `${liveIds.length} resource(s) in Twingate`,
            severity: 'warning',
          })
        }
      }
    }
  } catch (error) {
    diffs.push({
      field: 'twingate',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}

function indexByName(refs: NamedRef[]): Map<string, NamedRef> {
  return new Map(refs.filter((r) => r.name && r.id).map((r) => [groupKey(r.name as string), r]))
}
