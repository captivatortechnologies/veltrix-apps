import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildTenableClient } from '../../lib/tenable'
import { findUserGroup } from './deploy'
import { extractUserGroupSpecs } from './validate'

/**
 * Detect drift between the deployed user group configuration and the live
 * tenant state. The group NAME is both the logical identity and the only
 * managed attribute, so re-finding a group by its name and confirming it still
 * exists is the meaningful drift signal — a rename or deletion in the console
 * makes the managed name unresolvable, which surfaces here as missing.
 *
 * Membership is not managed by this config type, so member counts are never
 * diffed.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildTenableClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractUserGroupSpecs(ctx.deployedConfig).filter((s) => s.name)

  for (const spec of specs) {
    try {
      const live = await findUserGroup(client, spec.name)
      if (!live) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
      }
    } catch (error) {
      diffs.push({
        field: spec.name,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
