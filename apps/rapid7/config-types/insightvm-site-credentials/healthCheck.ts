import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildInsightVMClient, type InsightVMClient } from '../../lib/insightvm'
import { listSiteCredentials, resolveSiteId } from './deploy'
import { extractSiteCredentialSpecs } from './validate'

/**
 * Health check for site credential configuration:
 *   1. InsightVM console reachability (site list)
 *   2. Every declared credential (site, credential name) still exists
 * Score is the percentage of passed checks (0–100). The secret is never read.
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildInsightVMClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'insightvm_credential', passed: false, message: built.error }] }
  }
  const { client, consoleUrl } = built

  const specs = extractSiteCredentialSpecs(ctx.canvas).filter((s) => s.siteName && s.name)
  const siteIds = new Map<string, number>()

  const start = Date.now()
  let reachable = false
  try {
    await resolveSiteIfAny(client, specs, siteIds)
    reachable = true
    checks.push({ name: 'insightvm_reachable', passed: true, message: `InsightVM console reachable at ${consoleUrl}`, latencyMs: Date.now() - start })
  } catch (error) {
    checks.push({ name: 'insightvm_reachable', passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start })
  }

  if (reachable) {
    const credsBySite = new Map<number, Set<string>>()
    for (const spec of specs) {
      try {
        const siteId = await resolveSiteId(client, spec.siteName, siteIds)
        let names = credsBySite.get(siteId)
        if (!names) {
          const live = await listSiteCredentials(client, siteId)
          names = new Set(live.map((c) => c.name?.toLowerCase()).filter((n): n is string => typeof n === 'string'))
          credsBySite.set(siteId, names)
        }
        const present = names.has(spec.name.toLowerCase())
        checks.push({
          name: `credential:${spec.name} @ ${spec.siteName}`,
          passed: present,
          message: present ? `Credential "${spec.name}" is present` : `Credential "${spec.name}" is missing`,
        })
      } catch (error) {
        checks.push({ name: `credential:${spec.name} @ ${spec.siteName}`, passed: false, message: error instanceof Error ? error.message : 'Check failed' })
      }
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}

/** Warm the site-id cache (and prove reachability) via a single site list. */
async function resolveSiteIfAny(
  client: InsightVMClient,
  specs: ReturnType<typeof extractSiteCredentialSpecs>,
  siteIds: Map<string, number>,
): Promise<void> {
  if (specs.length > 0) {
    await resolveSiteId(client, specs[0].siteName, siteIds)
  } else {
    const res = await client.getAll('/sites')
    if (!res.ok) throw new Error(`InsightVM console not reachable (HTTP ${res.status})`)
  }
}
