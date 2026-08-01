import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildJumpCloudClient } from '../../lib/jumpcloudApi'
import { listSystemGroups } from './deploy'
import { extractSystemGroupSpecs, findSystemGroupByName } from './_shared'

/**
 * Detect drift between the deployed System Group configuration and the live org.
 * Re-finds each declared group by name and diffs the managed field (description).
 * A missing group is critical drift.
 *
 * Best-effort: if the org can't be read the check reports no drift rather than
 * raising a false positive. Only the fields this config type manages are compared
 * (server-managed fields like id and type are never diffed).
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildJumpCloudClient(ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const specs = extractSystemGroupSpecs(ctx.deployedConfig).filter((s) => s.name)

  let liveGroups
  try {
    liveGroups = await listSystemGroups(client)
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read groups, no drift asserted
  }

  for (const spec of specs) {
    const live = findSystemGroupByName(liveGroups, spec.name)
    if (!live) {
      diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }

    const liveDescription = String(live.description ?? '')
    if (spec.description !== liveDescription) {
      diffs.push({
        field: `${spec.name}.description`,
        expected: spec.description || 'not set',
        actual: liveDescription || 'not set',
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
