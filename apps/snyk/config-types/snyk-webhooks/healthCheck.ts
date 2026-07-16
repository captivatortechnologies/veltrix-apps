import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildSnykClient } from '../../lib/snyk'
import { listWebhooks } from './deploy'
import { extractWebhookSpecs, webhookKey } from './validate'

/**
 * Health check for webhook configuration:
 *   1. Snyk API reachability + token/org validity (a webhooks list)
 *   2. Every declared webhook URL still exists
 * Score is the percentage of passed checks (0–100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildSnykClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'snyk_credential', passed: false, message: built.error }] }
  }
  const { client, host } = built
  if (!client.hasOrg) {
    return { healthy: false, score: 0, checks: [{ name: 'snyk_org', passed: false, message: 'No Snyk organization id set' }] }
  }

  const start = Date.now()
  let live: Awaited<ReturnType<typeof listWebhooks>> | null = null
  try {
    live = await listWebhooks(client)
    checks.push({ name: 'snyk_reachable', passed: true, message: `Snyk API reachable at ${host}`, latencyMs: Date.now() - start })
  } catch (error) {
    checks.push({ name: 'snyk_reachable', passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start })
  }

  if (live) {
    const urls = new Set(live.filter((w) => w.url).map((w) => webhookKey(w.url as string)))
    for (const spec of extractWebhookSpecs(ctx.canvas).filter((s) => s.url)) {
      const present = urls.has(webhookKey(spec.url))
      checks.push({
        name: `webhook:${spec.url}`,
        passed: present,
        message: present ? `Webhook "${spec.url}" is present` : `Webhook "${spec.url}" is missing`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
