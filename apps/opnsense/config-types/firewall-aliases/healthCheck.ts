import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildOpnsenseClient, searchAliases, type LiveAlias } from '../../lib/opnsenseApi'
import { aliasKey, extractAliasSpecs } from './_shared'

/**
 * Health check for OPNsense firewall-aliases configuration:
 *   1. API reachability + credential validity (searchItem)
 *   2. Every declared alias (by name) still exists on the box
 * Read-only — never stages or applies a change. Score is the percentage of
 * passed checks (0–100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildOpnsenseClient(ctx.component.hostname, ctx.component.port, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'opnsense_credential', passed: false, message: built.error }] }
  }
  const { client, host } = built

  const specs = extractAliasSpecs(ctx.canvas).filter((s) => s.name)
  let live: LiveAlias[] = []
  const started = Date.now()

  try {
    live = await searchAliases(client)
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
      message: error instanceof Error ? error.message : 'searchItem failed',
      latencyMs: Date.now() - started,
    })
  }

  if (checks[0]?.passed) {
    const names = new Set(live.filter((a) => a.name).map((a) => aliasKey(a.name as string)))
    for (const spec of specs) {
      const present = names.has(aliasKey(spec.name))
      checks.push({
        name: `alias:${spec.name}`,
        passed: present,
        message: present ? `Alias "${spec.name}" is present` : `Alias "${spec.name}" is missing`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length === 0 ? 0 : Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
