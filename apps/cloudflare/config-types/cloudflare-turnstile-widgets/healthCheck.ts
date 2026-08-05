import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildCloudflareClient, cloudflareErrorMessage, MISSING_ACCOUNT_MESSAGE } from '../../lib/cloudflare'
import { listWidgets } from './deploy'
import { extractTurnstileWidgetSpecs, widgetKey } from './validate'

/**
 * Health check for Turnstile widget configuration:
 *   1. An account id is available (account-scoped objects need one)
 *   2. Cloudflare Turnstile API reachability (the token works, the account responds)
 *   3. Every declared widget (by name) still exists in the account
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
  const { client } = built

  if (!(await client.hasAccount())) {
    return {
      healthy: false,
      score: 0,
      checks: [{ name: 'cloudflare_account', passed: false, message: MISSING_ACCOUNT_MESSAGE }],
    }
  }

  const reachable = await timedCheck('cloudflare_reachable', async () => {
    const res = await client.account('GET', '/challenges/widgets', { query: { per_page: 1 } })
    if (!res.ok) throw new Error(cloudflareErrorMessage(res))
    return 'Cloudflare Turnstile API reachable for the account'
  })
  checks.push(reachable)

  if (reachable.passed) {
    const specs = extractTurnstileWidgetSpecs(ctx.canvas).filter((s) => s.name && s.domains.length > 0)
    if (specs.length > 0) {
      const live = await listWidgets(client)
      const keys = new Set(live.filter((w) => w.name).map((w) => widgetKey(w.name as string)))
      for (const spec of specs) {
        const present = keys.has(widgetKey(spec.name))
        checks.push({
          name: `widget:${spec.name}`,
          passed: present,
          message: present ? `Turnstile widget "${spec.name}" is present` : `Turnstile widget "${spec.name}" is missing`,
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
