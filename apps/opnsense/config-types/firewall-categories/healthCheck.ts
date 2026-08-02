import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildOpnsenseClient, searchCategories, type LiveCategory } from '../../lib/opnsenseApi'
import { categoryKey, extractCategorySpecs } from './_shared'

/**
 * Health check for OPNsense firewall-categories configuration: API
 * reachability + credential validity (searchItem), then every declared
 * category (by name) still exists. Read-only.
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildOpnsenseClient(ctx.component.hostname, ctx.component.port, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'opnsense_credential', passed: false, message: built.error }] }
  }
  const { client, host } = built

  const specs = extractCategorySpecs(ctx.canvas).filter((s) => s.name)
  let live: LiveCategory[] = []
  const started = Date.now()

  try {
    live = await searchCategories(client)
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
    const names = new Set(live.filter((c) => c.name).map((c) => categoryKey(c.name as string)))
    for (const spec of specs) {
      const present = names.has(categoryKey(spec.name))
      checks.push({
        name: `category:${spec.name}`,
        passed: present,
        message: present ? `Category "${spec.name}" is present` : `Category "${spec.name}" is missing`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length === 0 ? 0 : Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
