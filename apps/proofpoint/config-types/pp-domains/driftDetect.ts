import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildPPClient } from '../../lib/proofpoint'
import { listDomains } from './deploy'
import { domainKey, extractDomainSpecs, type LiveDomain } from './validate'

/**
 * Detect drift between the deployed domain configuration and the live org.
 * Re-finds each declared domain by name and diffs the managed fields (is_active,
 * is_relay, destination); a missing domain is critical drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildPPClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractDomainSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listDomains(client)
    const byKey = new Map<string, LiveDomain>(live.filter((d) => d.name).map((d) => [domainKey(d.name as string), d]))

    for (const spec of specs) {
      const found = byKey.get(domainKey(spec.name))
      if (!found) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }
      if ((found.is_active ?? true) !== spec.isActive) {
        diffs.push({ field: `${spec.name}.is_active`, expected: spec.isActive, actual: found.is_active ?? true, severity: 'warning' })
      }
      if ((found.is_relay ?? false) !== spec.isRelay) {
        diffs.push({ field: `${spec.name}.is_relay`, expected: spec.isRelay, actual: found.is_relay ?? false, severity: 'warning' })
      }
      const liveDestination = (typeof found.destination === 'string' ? found.destination : '').trim()
      if (spec.destination !== liveDestination) {
        diffs.push({ field: `${spec.name}.destination`, expected: spec.destination || 'not set', actual: liveDestination || 'not set', severity: 'info' })
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
