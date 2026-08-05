import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildQualysClient } from '../../lib/qualys'
import { listNetworks } from './deploy'
import { extractNetworkSpecs, networkKey, type LiveNetwork } from './validate'

/**
 * Health check for custom network configuration:
 *   1. Qualys platform reachability + credential validity (a network list)
 *   2. Every declared network still exists
 * Score is the percentage of passed checks (0–100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildQualysClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'qualys_credential', passed: false, message: built.error }] }
  }
  const { client, platformUrl } = built

  const start = Date.now()
  let live: LiveNetwork[] | null = null
  try {
    live = await listNetworks(client)
    checks.push({
      name: 'qualys_reachable',
      passed: true,
      message: `Qualys platform reachable at ${platformUrl}`,
      latencyMs: Date.now() - start,
    })
  } catch (error) {
    checks.push({
      name: 'qualys_reachable',
      passed: false,
      message: error instanceof Error ? error.message : 'Check failed',
      latencyMs: Date.now() - start,
    })
  }

  if (live) {
    const keys = new Set(live.map((n) => networkKey(n)))
    for (const spec of extractNetworkSpecs(ctx.canvas).filter((s) => s.name)) {
      const present = keys.has(networkKey(spec))
      checks.push({
        name: `network:${spec.name}`,
        passed: present,
        message: present ? `Network "${spec.name}" is present` : `Network "${spec.name}" is missing`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length > 0 ? Math.round((passedCount / checks.length) * 100) : 0
  return { healthy: passedCount === checks.length, score, checks }
}
