import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildVaultClient } from '../../lib/vault'
import { getSentinelPolicy } from './deploy'
import { extractSentinelPolicySpecs, normalizeSentinelPolicy, sentinelKey, type SentinelScope } from './validate'

/**
 * Detect drift between the deployed Sentinel policy configuration and the live
 * cluster. Re-reads each policy from GET /sys/policies/{scope}/{name} and
 * diffs the authored fields:
 *
 *   - policy body       → warning (normalized before comparing — see
 *                          normalizeSentinelPolicy)
 *   - enforcement_level → warning
 *   - paths (egp only)  → warning (compared as a set)
 *
 * A policy deleted out-of-band is flagged critical (the managed object is gone).
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildVaultClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractSentinelPolicySpecs(ctx.deployedConfig).filter(
    (s) => s.scope && s.name && s.policy && s.enforcementLevel,
  )

  for (const spec of specs) {
    const scope = spec.scope as SentinelScope
    const key = sentinelKey(scope, spec.name)
    try {
      const live = await getSentinelPolicy(client, scope, spec.name)

      if (!live) {
        diffs.push({ field: key, expected: 'present', actual: 'missing', severity: 'critical' })
        continue
      }

      const expectedPolicy = normalizeSentinelPolicy(spec.policy)
      const actualPolicy = normalizeSentinelPolicy(typeof live.policy === 'string' ? live.policy : '')
      if (expectedPolicy !== actualPolicy) {
        diffs.push({ field: `${key}.policy`, expected: expectedPolicy, actual: actualPolicy, severity: 'warning' })
      }

      const liveLevel = typeof live.enforcement_level === 'string' ? live.enforcement_level : ''
      if (liveLevel !== spec.enforcementLevel) {
        diffs.push({
          field: `${key}.enforcementLevel`,
          expected: spec.enforcementLevel,
          actual: liveLevel || 'not set',
          severity: 'warning',
        })
      }

      if (scope === 'egp') {
        const livePaths = Array.isArray(live.paths) ? [...live.paths].sort().join(',') : ''
        const expectedPaths = [...spec.paths].sort().join(',')
        if (livePaths !== expectedPaths) {
          diffs.push({
            field: `${key}.paths`,
            expected: expectedPaths || '(none)',
            actual: livePaths || '(none)',
            severity: 'warning',
          })
        }
      }
    } catch (error) {
      diffs.push({
        field: key,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
