import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildCloudflareClient, MISSING_ACCOUNT_MESSAGE } from '../../lib/cloudflare'
import { listGatewayLists } from './deploy'
import { extractGatewayListSpecs, gatewayListKey, type LiveGatewayList } from './validate'

/**
 * Health check for Gateway list configuration:
 *   1. Cloudflare API reachability + account resolution (the token works, the
 *      account-scoped /gateway/lists collection is readable)
 *   2. Every declared list still exists in the account
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

  if (!(await client.hasAccount())) {
    return {
      healthy: false,
      score: 0,
      checks: [{ name: 'cloudflare_account', passed: false, message: MISSING_ACCOUNT_MESSAGE }],
    }
  }

  let liveLists: LiveGatewayList[] = []
  const reachable = await timedCheck('cloudflare_reachable', async () => {
    liveLists = await listGatewayLists(client)
    return `Cloudflare reachable; resolved account for "${domain}"`
  })
  checks.push(reachable)

  if (reachable.passed) {
    const specs = extractGatewayListSpecs(ctx.canvas).filter((s) => s.name && s.type)
    if (specs.length > 0) {
      const keys = new Set(liveLists.filter((l) => l.name).map((l) => gatewayListKey(l.name as string)))
      for (const spec of specs) {
        const present = keys.has(gatewayListKey(spec.name))
        checks.push({
          name: `list:${spec.name}`,
          passed: present,
          message: present ? `List "${spec.name}" is present` : `List "${spec.name}" is missing`,
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
