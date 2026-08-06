import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildGravityZoneClient } from '../../lib/gravityZone'
import { getCustomGroupsList } from '../../lib/gravityZoneApi'
import { extractNetworkGroupSpecs, findLiveGroup } from './_shared'

/**
 * Detect drift for network groups: for each declared (groupName, parentId),
 * confirm a direct child of parentId with that name still exists. A missing
 * group is critical drift (GravityZone would no longer have this container).
 * There is no other mutable field to compare — see README.md "Coverage".
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildGravityZoneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const specs = extractNetworkGroupSpecs(ctx.deployedConfig).filter((s) => s.groupName)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  const liveByParent = new Map<string, Awaited<ReturnType<typeof getCustomGroupsList>>>()

  for (const spec of specs) {
    const parentKey = spec.parentId || '(root)'
    let live = liveByParent.get(parentKey)
    if (live === undefined) {
      try {
        live = await getCustomGroupsList(client, spec.parentId || undefined)
      } catch {
        continue
      }
      liveByParent.set(parentKey, live)
    }

    const match = findLiveGroup(live, spec.groupName)
    if (!match) {
      diffs.push({
        field: `${spec.groupName}${spec.parentId ? ` (parent ${spec.parentId})` : ''}`,
        expected: 'present',
        actual: 'missing',
        severity: 'critical',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
