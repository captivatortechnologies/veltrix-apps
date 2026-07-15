import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildCloudflareClient, MISSING_ACCOUNT_MESSAGE } from '../../lib/cloudflare'
import { listAccessGroups } from './deploy'
import { extractAccessGroupSpecs } from './validate'

/**
 * Health check for Access group configuration:
 *   1. Cloudflare API reachability + zone resolution (the token works, zone found)
 *   2. Every declared group (by name) still exists in the account
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

  // Account-scoped: without a resolvable account id the check fails outright.
  if (!(await client.hasAccount())) {
    return {
      healthy: false,
      score: 0,
      checks: [{ name: 'cloudflare_account', passed: false, message: MISSING_ACCOUNT_MESSAGE }],
    }
  }

  const reachable = await timedCheck('cloudflare_reachable', async () => {
    const zone = await client.resolveZone()
    if ('error' in zone) throw new Error(zone.error)
    return `Cloudflare reachable; resolved zone for "${domain}"`
  })
  checks.push(reachable)

  if (reachable.passed) {
    const specs = extractAccessGroupSpecs(ctx.canvas).filter((s) => s.name && s.includeJson.trim())
    if (specs.length > 0) {
      const live = await listAccessGroups(client)
      const names = new Set(live.filter((g) => g.name).map((g) => g.name as string))
      for (const spec of specs) {
        const present = names.has(spec.name)
        checks.push({
          name: `group:${spec.name}`,
          passed: present,
          message: present ? `Access group "${spec.name}" is present` : `Access group "${spec.name}" is missing`,
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
