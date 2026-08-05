import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildBarracudaClient } from '../../lib/barracudaWaf'
import { extractResponsePageSpecs, listResponsePages, responsePageKey, type LiveResponsePage } from './validate'

/**
 * Health check for Response Pages:
 *   1. Barracuda WAF-as-a-Service reachability + credential/Application validity
 *   2. Every declared page still exists and its status code matches
 * Score is the percentage of passed checks (0-100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildBarracudaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'barracuda_credential', passed: false, message: built.error }] }
  }
  const { client, appName } = built

  const specs = extractResponsePageSpecs(ctx.canvas).filter((s) => s.name)
  const start = Date.now()
  let live: LiveResponsePage[] | null = null

  try {
    live = await listResponsePages(client, appName)
    checks.push({ name: 'barracuda_reachable', passed: true, message: `Barracuda WAF-as-a-Service reachable — Application "${appName}"`, latencyMs: Date.now() - start })
  } catch (error) {
    checks.push({ name: 'barracuda_reachable', passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start })
  }

  if (live) {
    const byKey = new Map(live.filter((p) => p.name).map((p) => [responsePageKey(p.name as string), p]))
    for (const spec of specs) {
      const found = byKey.get(responsePageKey(spec.name))
      if (!found) {
        checks.push({ name: `page:${spec.name}`, passed: false, message: `Response Page "${spec.name}" is missing` })
        continue
      }
      const matches = (found.status_code ?? '') === spec.statusCode
      checks.push({
        name: `page:${spec.name}`,
        passed: matches,
        message: matches ? `Response Page "${spec.name}" is present (status_code=${spec.statusCode})` : `Response Page "${spec.name}" status_code drifted`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length > 0 ? Math.round((passedCount / checks.length) * 100) : 0
  return { healthy: passedCount === checks.length, score, checks }
}
