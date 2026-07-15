import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildCloudflareClient } from '../../lib/cloudflare'
import { getEntrypoint } from './deploy'
import { extractManagedRulesetSpecs } from './validate'

/**
 * Health check for managed ruleset configuration:
 *   1. Cloudflare API reachability + zone resolution
 *   2. Every declared managed-ruleset deployment (by ref) is present in the
 *      phase entrypoint
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
    const specs = extractManagedRulesetSpecs(ctx.canvas).filter((s) => s.name && s.managedRulesetId)
    if (specs.length > 0) {
      const entry = await getEntrypoint(client)
      const refs = new Set(entry.rules.map((r) => r.ref))
      for (const spec of specs) {
        const present = refs.has(spec.ref)
        checks.push({
          name: `rule:${spec.name}`,
          passed: present,
          message: present ? `Managed ruleset "${spec.name}" is deployed` : `Managed ruleset "${spec.name}" (ref ${spec.ref}) is missing`,
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
