import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildTenableClient } from '../../lib/tenable'
import { findFolder } from './deploy'
import { extractFolderSpecs } from './validate'

/**
 * Detect drift between the deployed folder configuration and the live tenant.
 * Re-finds each declared folder by its name (the logical identity).
 *
 * A folder's ONLY managed field is its name — which is the identity we match on
 * — so there is no non-identity field to diff. The single meaningful drift is
 * existence: a folder that was deployed but is no longer present (deleted, or
 * renamed in the console so its managed name no longer resolves) reads as
 * critical drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildTenableClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractFolderSpecs(ctx.deployedConfig).filter((s) => s.name)

  for (const spec of specs) {
    const label = spec.name
    try {
      const live = await findFolder(client, spec.name)
      if (!live) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
      }
    } catch (error) {
      diffs.push({
        field: label,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
