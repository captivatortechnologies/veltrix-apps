import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient } from '../../lib/okta'
import { getThreatInsight } from './deploy'
import { extractThreatInsightSpecs } from './validate'

/**
 * Detect drift between the deployed ThreatInsight configuration and the live org.
 * Compares:
 *   - action (none | audit | block)
 *   - excludeZones (order-insensitive)
 *
 * Server-managed readOnly fields (created, lastUpdated, _links) are never modeled
 * so they cannot read as drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractThreatInsightSpecs(ctx.deployedConfig).filter((s) => s.action)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }
  const spec = specs[0]

  let live
  try {
    live = await getThreatInsight(client)
  } catch (error) {
    return {
      hasDrift: true,
      diffs: [
        {
          field: 'threat-insight',
          expected: 'reachable',
          actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
          severity: 'critical',
        },
      ],
    }
  }

  // action
  const liveAction = (live?.action ?? '').toString().toLowerCase()
  if (spec.action !== liveAction) {
    diffs.push({
      field: 'action',
      expected: spec.action,
      actual: liveAction || 'not set',
      severity: 'critical',
    })
  }

  // excludeZones — order-insensitive
  const expectedZones = [...spec.excludeZones].sort()
  const liveZones = [...(live?.excludeZones ?? [])].map(String).sort()
  if (JSON.stringify(expectedZones) !== JSON.stringify(liveZones)) {
    diffs.push({
      field: 'excludeZones',
      expected: expectedZones,
      actual: liveZones,
      severity: 'warning',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
