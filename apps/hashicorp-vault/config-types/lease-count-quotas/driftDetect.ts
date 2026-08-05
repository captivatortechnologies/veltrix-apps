import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildVaultClient } from '../../lib/vault'
import { getLeaseCountQuota } from './deploy'
import { extractLeaseCountQuotaSpecs } from './validate'

/**
 * Detect drift between the deployed lease count quota configuration and the
 * live cluster. Re-reads each quota from GET /sys/quotas/lease-count/{name} and
 * diffs only the AUTHORED fields:
 *
 *   - max_leases   → warning
 *   - path         → warning (always authored; "" = the global limiter)
 *   - role         → warning (only when set)
 *   - inheritable  → warning
 *
 * The server-computed `type` field is intentionally EXCLUDED. A quota that has
 * been deleted out-of-band is flagged critical (the managed object is gone).
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildVaultClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractLeaseCountQuotaSpecs(ctx.deployedConfig).filter(
    (s) => s.name && Number.isInteger(s.maxLeases) && s.maxLeases > 0,
  )

  for (const spec of specs) {
    try {
      const live = await getLeaseCountQuota(client, spec.name)

      if (!live) {
        diffs.push({ field: spec.name, expected: 'present', actual: 'missing', severity: 'critical' })
        continue
      }

      // max_leases — the core managed field.
      if (typeof live.max_leases === 'number' && live.max_leases !== spec.maxLeases) {
        diffs.push({
          field: `${spec.name}.maxLeases`,
          expected: String(spec.maxLeases),
          actual: String(live.max_leases),
          severity: 'warning',
        })
      }

      // path — always authored; "" is the deliberate global-limiter choice.
      const livePath = typeof live.path === 'string' ? live.path : ''
      if (livePath !== spec.path) {
        diffs.push({
          field: `${spec.name}.path`,
          expected: spec.path || '(global — empty path)',
          actual: livePath || '(global — empty path)',
          severity: 'warning',
        })
      }

      // role — only when authored.
      if (spec.role !== undefined) {
        const liveRole = typeof live.role === 'string' ? live.role : ''
        if (liveRole !== spec.role) {
          diffs.push({ field: `${spec.name}.role`, expected: spec.role, actual: liveRole || 'not set', severity: 'warning' })
        }
      }

      // inheritable — always authored (defaults to false).
      const liveInheritable = live.inheritable === true
      if (liveInheritable !== spec.inheritable) {
        diffs.push({
          field: `${spec.name}.inheritable`,
          expected: String(spec.inheritable),
          actual: String(liveInheritable),
          severity: 'warning',
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
