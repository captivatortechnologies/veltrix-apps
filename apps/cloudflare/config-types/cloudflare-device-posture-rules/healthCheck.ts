import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildCloudflareClient, cloudflareErrorMessage, MISSING_ACCOUNT_MESSAGE } from '../../lib/cloudflare'
import { listPostureRules } from './deploy'
import { extractPostureRuleSpecs, postureRuleKey } from './validate'

/**
 * Health check for device posture rule configuration:
 *   1. An account id is available (account-scoped objects need one)
 *   2. Cloudflare Zero Trust API reachability (the token works, the account responds)
 *   3. Every declared rule (by name) still exists in the account
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
    const res = await client.account('GET', '/devices/posture', { query: { per_page: 1 } })
    if (!res.ok) throw new Error(cloudflareErrorMessage(res))
    return 'Cloudflare Zero Trust API reachable for the account'
  })
  checks.push(reachable)

  if (reachable.passed) {
    const specs = extractPostureRuleSpecs(ctx.canvas).filter((s) => s.name && s.inputJson.trim())
    if (specs.length > 0) {
      const live = await listPostureRules(client)
      const keys = new Set(live.filter((r) => r.name).map((r) => postureRuleKey(r.name as string)))
      for (const spec of specs) {
        const present = keys.has(postureRuleKey(spec.name))
        checks.push({
          name: `rule:${spec.name}`,
          passed: present,
          message: present ? `Posture rule "${spec.name}" is present` : `Posture rule "${spec.name}" is missing`,
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
