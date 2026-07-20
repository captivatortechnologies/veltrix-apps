import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient } from '../../lib/okta'
import { findFeature } from './deploy'
import { extractFeatureSpecs } from './validate'

/**
 * Detect drift between the deployed feature toggles and the live Okta org. Each
 * declared feature is re-found by name (case-insensitive):
 *   - a feature that no longer exists reads as a critical diff (missing)
 *   - a status that no longer matches the desired ENABLED/DISABLED reads as a
 *     critical diff — the toggle is the whole point of this config type
 *
 * The release `stage` is intentionally NOT compared: it is Okta-managed metadata
 * this type never sets, so surfacing it would be noise.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractFeatureSpecs(ctx.deployedConfig).filter((s) => s.name)

  for (const spec of specs) {
    try {
      const live = await findFeature(client, spec.name)

      if (!live) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      const liveStatus = (live.status ?? '').toUpperCase()
      if (spec.status && liveStatus !== spec.status) {
        diffs.push({
          field: `${spec.name}.status`,
          expected: spec.status,
          actual: liveStatus || 'not set',
          severity: 'critical',
        })
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
