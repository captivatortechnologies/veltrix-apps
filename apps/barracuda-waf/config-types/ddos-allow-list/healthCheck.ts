import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildBarracudaClient } from '../../lib/barracudaWaf'
import { allowListKey, extractDdosAllowListSpecs, listAllowList, type LiveAllowListEntry } from './validate'

/**
 * Health check for the DDoS allow list:
 *   1. Barracuda WAF-as-a-Service reachability + credential/Application validity
 *   2. Every declared IP is present in the live allow list
 * Score is the percentage of passed checks (0-100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildBarracudaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'barracuda_credential', passed: false, message: built.error }] }
  }
  const { client, appName } = built

  const specs = extractDdosAllowListSpecs(ctx.canvas).filter((s) => s.ip)
  const start = Date.now()
  let live: LiveAllowListEntry[] | null = null

  try {
    live = await listAllowList(client, appName)
    checks.push({ name: 'barracuda_reachable', passed: true, message: `Barracuda WAF-as-a-Service reachable — Application "${appName}"`, latencyMs: Date.now() - start })
  } catch (error) {
    checks.push({ name: 'barracuda_reachable', passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start })
  }

  if (live) {
    const byKey = new Map(live.filter((e) => e.ip).map((e) => [allowListKey(e.ip as string), e]))
    for (const spec of specs) {
      const found = byKey.get(allowListKey(spec.ip))
      checks.push({
        name: `allow_list:${spec.ip}`,
        passed: !!found,
        message: found ? `Allow-list entry "${spec.ip}" is present` : `Allow-list entry "${spec.ip}" is missing`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length > 0 ? Math.round((passedCount / checks.length) * 100) : 0
  return { healthy: passedCount === checks.length, score, checks }
}
