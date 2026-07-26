import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildPPClient } from '../../lib/proofpoint'
import { extractFeatureSpecs, getFeatures, readFeature } from './validate'

/**
 * Detect drift between the deployed feature configuration and the live org.
 * Each declared feature is re-read and diffed against its declared state; a
 * feature whose live value no longer matches is drift, and a feature that has
 * disappeared from the org (e.g. a package downgrade) is critical drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildPPClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractFeatureSpecs(ctx.deployedConfig).filter((s) => s.feature)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const features = await getFeatures(client)
    for (const spec of specs) {
      const current = readFeature(features, spec.feature)
      if (current === null) {
        diffs.push({ field: spec.feature, expected: spec.enabled, actual: 'unavailable', severity: 'critical' })
        continue
      }
      if (current !== spec.enabled) {
        diffs.push({ field: spec.feature, expected: spec.enabled, actual: current, severity: 'warning' })
      }
    }
  } catch (error) {
    diffs.push({
      field: 'proofpoint',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
