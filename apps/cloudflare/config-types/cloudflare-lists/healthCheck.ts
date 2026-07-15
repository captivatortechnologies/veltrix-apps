import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildCloudflareClient, MISSING_ACCOUNT_MESSAGE } from '../../lib/cloudflare'
import { listLists } from './deploy'
import { extractListSpecs, type LiveList } from './validate'

/**
 * Health check for List configuration:
 *   1. An account is available (account-scoped object) and the API is reachable
 *   2. Every declared list still exists in the account (matched by name)
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

  let liveLists: LiveList[] = []
  const reachable = await timedCheck('cloudflare_reachable', async () => {
    liveLists = await listLists(client)
    return 'Cloudflare account API reachable; listed account Lists'
  })
  checks.push(reachable)

  if (reachable.passed) {
    const specs = extractListSpecs(ctx.canvas).filter((s) => s.name)
    if (specs.length > 0) {
      const names = new Set(liveLists.filter((l) => l.name).map((l) => l.name as string))
      for (const spec of specs) {
        const present = names.has(spec.name)
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
