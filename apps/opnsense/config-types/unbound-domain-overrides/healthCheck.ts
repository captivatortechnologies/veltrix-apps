import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { searchDomainOverrides, type LiveDomainOverride } from '../../lib/unboundApi'
import { buildOpnsenseClient } from '../../lib/opnsenseApi'
import { domainOverrideKey, extractDomainOverrideSpecs } from './_shared'

/**
 * Health check for OPNsense unbound-domain-overrides configuration: API
 * reachability + credential validity (searchForward), then every declared
 * override (by domain) still exists as a "forward"-type entry. Read-only.
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildOpnsenseClient(ctx.component.hostname, ctx.component.port, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'opnsense_credential', passed: false, message: built.error }] }
  }
  const { client, host } = built

  const specs = extractDomainOverrideSpecs(ctx.canvas).filter((s) => s.domain)
  let live: LiveDomainOverride[] = []
  const started = Date.now()

  try {
    live = await searchDomainOverrides(client)
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
      message: error instanceof Error ? error.message : 'searchForward failed',
      latencyMs: Date.now() - started,
    })
  }

  if (checks[0]?.passed) {
    const keys = new Set(
      live.filter((d) => d.domain && (d.type ?? 'forward') === 'forward').map((d) => domainOverrideKey(d.domain as string)),
    )
    for (const spec of specs) {
      const present = keys.has(domainOverrideKey(spec.domain))
      checks.push({
        name: `domain:${spec.domain}`,
        passed: present,
        message: present ? `Domain override "${spec.domain}" is present` : `Domain override "${spec.domain}" is missing`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length === 0 ? 0 : Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
