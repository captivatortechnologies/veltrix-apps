import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildCloudflareClient } from '../../lib/cloudflare'
import { listPageRules } from './deploy'
import { extractPageRuleSpecs, livePageRulePattern, pageRuleKey } from './validate'

/**
 * Health check for Page Rule configuration:
 *   1. Cloudflare API reachability + zone resolution (the token works, zone found)
 *   2. Every declared rule (by URL pattern) still exists in the zone
 * Score is the percentage of passed checks (0–100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildCloudflareClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return {
      healthy: false,
      score: 0,
      checks: [{ name: 'cloudflare_credential', passed: false, message: built.error }],
    }
  }
  const { client, domain } = built

  const reachable = await timedCheck('cloudflare_reachable', async () => {
    const zone = await client.resolveZone()
    if ('error' in zone) throw new Error(zone.error)
    return `Cloudflare reachable; resolved zone for "${domain}"`
  })
  checks.push(reachable)

  if (reachable.passed) {
    const specs = extractPageRuleSpecs(ctx.canvas).filter((s) => s.urlPattern && s.actionsJson.trim())
    if (specs.length > 0) {
      const live = await listPageRules(client)
      const keys = new Set(live.map((r) => pageRuleKey(livePageRulePattern(r))).filter((k) => k.length > 0))
      for (const spec of specs) {
        const present = keys.has(spec.key)
        checks.push({
          name: `rule:${spec.urlPattern}`,
          passed: present,
          message: present ? `Page Rule "${spec.urlPattern}" is present` : `Page Rule "${spec.urlPattern}" is missing`,
        })
      }
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}

async function timedCheck(
  name: string,
  fn: () => Promise<string>,
): Promise<HealthCheckResult['checks'][0]> {
  const start = Date.now()
  try {
    const message = await fn()
    return { name, passed: true, message, latencyMs: Date.now() - start }
  } catch (error) {
    return {
      name,
      passed: false,
      message: error instanceof Error ? error.message : 'Check failed',
      latencyMs: Date.now() - start,
    }
  }
}
