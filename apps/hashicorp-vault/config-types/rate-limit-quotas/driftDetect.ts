import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildVaultClient } from '../../lib/vault'
import { getQuota } from './deploy'
import { extractQuotaSpecs, parseDurationSeconds } from './validate'

/**
 * Detect drift between the deployed rate limit quota configuration and the live
 * cluster. Re-reads each quota from GET /sys/quotas/rate-limit/{name} and diffs
 * only the AUTHORED fields:
 *
 *   - rate            → warning
 *   - path            → warning (always authored; "" = the global limiter)
 *   - interval        → warning (canvas duration vs live seconds; only when set)
 *   - block_interval  → warning (only when set)
 *   - role            → warning (only when set)
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

  const specs = extractQuotaSpecs(ctx.deployedConfig).filter((s) => s.name && Number.isFinite(s.rate) && s.rate > 0)

  for (const spec of specs) {
    try {
      const live = await getQuota(client, spec.name)

      if (!live) {
        diffs.push({ field: spec.name, expected: 'present', actual: 'missing', severity: 'critical' })
        continue
      }

      // rate — the core managed field.
      if (typeof live.rate === 'number' && live.rate !== spec.rate) {
        diffs.push({ field: `${spec.name}.rate`, expected: String(spec.rate), actual: String(live.rate), severity: 'warning' })
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

      // interval / block_interval — only when the canvas manages them, normalized
      // to seconds (Vault echoes them as a whole number of seconds).
      compareDuration(diffs, `${spec.name}.interval`, spec.interval, live.interval)
      compareDuration(diffs, `${spec.name}.blockInterval`, spec.blockInterval, live.block_interval)

      // role — only when authored.
      if (spec.role !== undefined) {
        const liveRole = typeof live.role === 'string' ? live.role : ''
        if (liveRole !== spec.role) {
          diffs.push({ field: `${spec.name}.role`, expected: spec.role, actual: liveRole || 'not set', severity: 'warning' })
        }
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

/** Compare a canvas duration (e.g. "1s") to a live value in seconds, pushing a warning diff. */
function compareDuration(
  diffs: DriftDiff[],
  field: string,
  expectedRaw: string | undefined,
  liveSeconds: number | undefined,
): void {
  if (expectedRaw === undefined) return
  const expected = parseDurationSeconds(expectedRaw)
  // An unparseable canvas duration is caught by validate — don't invent drift here.
  if (expected === undefined) return
  const actual = typeof liveSeconds === 'number' && Number.isFinite(liveSeconds) ? liveSeconds : undefined
  if (expected !== actual) {
    diffs.push({
      field,
      expected: `${expectedRaw} (${expected}s)`,
      actual: actual !== undefined ? `${actual}s` : 'not set',
      severity: 'warning',
    })
  }
}
