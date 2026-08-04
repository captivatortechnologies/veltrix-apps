import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { searchHostOverrides, type LiveHostOverride } from '../../lib/unboundApi'
import { buildOpnsenseClient } from '../../lib/opnsenseApi'
import { extractHostOverrideSpecs, hostOverrideKey } from './_shared'

/**
 * Health check for OPNsense unbound-host-overrides configuration: API
 * reachability + credential validity (searchHostOverride), then every
 * declared override (by hostname+domain) still exists. Read-only.
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildOpnsenseClient(ctx.component.hostname, ctx.component.port, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'opnsense_credential', passed: false, message: built.error }] }
  }
  const { client, host } = built

  const specs = extractHostOverrideSpecs(ctx.canvas).filter((s) => s.hostname && s.domain)
  let live: LiveHostOverride[] = []
  const started = Date.now()

  try {
    live = await searchHostOverrides(client)
    checks.push({
      name: 'opnsense_reachable',
      passed: true,
      message: `Reached the OPNsense API at ${host}`,
      latencyMs: Date.now() - started,
    })
  } catch (error) {
    checks.push({
      name: 'opnsense_reachable',
      passed: false,
      message: error instanceof Error ? error.message : 'searchHostOverride failed',
      latencyMs: Date.now() - started,
    })
  }

  if (checks[0]?.passed) {
    const keys = new Set(live.filter((h) => h.hostname && h.domain).map((h) => hostOverrideKey(h.hostname as string, h.domain as string)))
    for (const spec of specs) {
      const label = `${spec.hostname}.${spec.domain}`
      const present = keys.has(hostOverrideKey(spec.hostname, spec.domain))
      checks.push({
        name: `host:${label}`,
        passed: present,
        message: present ? `Host override "${label}" is present` : `Host override "${label}" is missing`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length === 0 ? 0 : Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
