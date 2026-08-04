import type { HealthCheckContext, HealthCheckResult, HealthCheck } from '@veltrixsecops/app-sdk'
import { buildPagerDutyClient, pagerDutyErrorMessage } from '../../lib/pagerdutyApi'
import { extractWebhookSubscriptionSpecs, findWebhookSubscription } from './_shared'
import { listWebhookSubscriptions } from './deploy'

/**
 * Health check for webhook-subscriptions configuration:
 *   1. PagerDuty API reachability + auth (GET /abilities answers 2xx with the key)
 *   2. every declared subscription (by description) still exists in the account
 * Score is the fraction of passed checks (0–1).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheck[] = []

  const built = buildPagerDutyClient(ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'credential', passed: false, message: built.error }] }
  }
  const { client } = built

  const started = Date.now()
  let reachable = false
  try {
    const res = await client.request('GET', '/abilities')
    reachable = res.ok
    checks.push({
      name: 'pagerduty_reachable',
      passed: res.ok,
      message: res.ok ? `PagerDuty reachable (HTTP ${res.status}).` : `PagerDuty returned HTTP ${res.status}: ${pagerDutyErrorMessage(res)}`,
      latencyMs: Date.now() - started,
    })
  } catch (error) {
    checks.push({
      name: 'pagerduty_reachable',
      passed: false,
      message: `PagerDuty unreachable: ${error instanceof Error ? error.message : 'error'}`,
      latencyMs: Date.now() - started,
    })
  }

  if (reachable) {
    const specs = extractWebhookSubscriptionSpecs(ctx.canvas).filter((s) => s.description && s.url && s.filterType)
    if (specs.length > 0) {
      try {
        const live = await listWebhookSubscriptions(client)
        for (const spec of specs) {
          const present = Boolean(findWebhookSubscription(live, spec.description))
          checks.push({
            name: `webhook_subscription:${spec.description}`,
            passed: present,
            message: present
              ? `Webhook subscription "${spec.description}" is present.`
              : `Webhook subscription "${spec.description}" is missing.`,
          })
        }
      } catch (error) {
        checks.push({
          name: 'webhook_subscriptions_readable',
          passed: false,
          message: `Could not list webhook subscriptions: ${error instanceof Error ? error.message : 'error'}`,
        })
      }
    }
  }

  const passed = checks.filter((c) => c.passed).length
  return { healthy: passed === checks.length, score: checks.length ? passed / checks.length : 0, checks }
}
