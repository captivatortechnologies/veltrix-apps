import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildXrayClient } from '../../lib/xrayApi'
import { webhookPath } from './deploy'
import { extractWebhookSpecs } from './_shared'

/**
 * Health check for the webhooks configuration:
 *   1. Xray reachability + credential validity — probed via the first declared
 *      webhook's read call (this object has no list-all endpoint; see deploy.ts).
 *   2. Every declared webhook (by name) still exists in the tenant.
 * Score is the percentage of passed checks (0–100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildXrayClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'xray_credential', passed: false, message: built.error }] }
  }
  const { client, host } = built

  const specs = extractWebhookSpecs(ctx.canvas).filter((s) => s.name)
  if (specs.length === 0) {
    return { healthy: true, score: 100, checks: [{ name: 'xray_reachable', passed: true, message: `No webhooks declared for ${host}` }] }
  }

  const started = Date.now()
  for (const spec of specs) {
    const res = await client.request('GET', webhookPath(spec.name))
    if (checks.length === 0) {
      const reachable = res.status > 0
      checks.push({
        name: 'xray_reachable',
        passed: reachable,
        message: reachable ? `Xray reachable at ${host}` : `Could not reach Xray at ${host}`,
        latencyMs: Date.now() - started,
      })
      if (!reachable) break
    }
    checks.push({
      name: `webhook:${spec.name}`,
      passed: res.ok,
      message: res.ok ? `Webhook "${spec.name}" is present` : `Webhook "${spec.name}" is missing`,
    })
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length === 0 ? 0 : Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
