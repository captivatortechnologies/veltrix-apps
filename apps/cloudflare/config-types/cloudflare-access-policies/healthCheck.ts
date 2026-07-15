import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildCloudflareClient, MISSING_ACCOUNT_MESSAGE } from '../../lib/cloudflare'
import { listAccessPolicies } from './deploy'
import { extractAccessPolicySpecs, type LiveAccessPolicy } from './validate'

/**
 * Health check for Access policy configuration:
 *   1. An account is resolvable (account-scoped objects need one)
 *   2. Cloudflare API reachability (the token can list /access/policies)
 *   3. Every declared policy (by name) still exists in the account
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

  const specs = extractAccessPolicySpecs(ctx.canvas).filter((s) => s.name)
  let live: LiveAccessPolicy[] = []

  const reachable = await timedCheck('cloudflare_reachable', async () => {
    live = await listAccessPolicies(client)
    return 'Cloudflare reachable; Access policies API responded'
  })
  checks.push(reachable)

  if (reachable.passed && specs.length > 0) {
    const names = new Set(live.filter((p) => p.name).map((p) => p.name as string))
    for (const spec of specs) {
      const present = names.has(spec.name)
      checks.push({
        name: `policy:${spec.name}`,
        passed: present,
        message: present ? `Policy "${spec.name}" is present` : `Policy "${spec.name}" is missing`,
      })
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
