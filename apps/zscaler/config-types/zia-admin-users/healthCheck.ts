import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildZscalerClient, parseJson, zscalerErrorMessage } from '../../lib/zscaler'
import { listAdminUsers } from './deploy'
import { extractAdminUserSpecs } from './validate'

/**
 * Health check for admin user configuration:
 *   1. ZIA API reachability + credential validity (GET /status)
 *   2. Every declared admin user still exists in the tenant (matched by loginName)
 * Score is the percentage of passed checks (0–100).
 *
 * The password is never checked — it is a write-only secret ZIA never returns.
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return {
      healthy: false,
      score: 0,
      checks: [{ name: 'zscaler_credential', passed: false, message: built.error }],
    }
  }
  const { client, vanity } = built

  const reachable = await timedCheck('zia_reachable', async () => {
    const res = await client.activationStatus()
    if (res.status === 401 || res.status === 403) {
      throw new Error('Zscaler rejected the OneAPI credential (check the API client id/secret and its ZIA roles)')
    }
    if (!res.ok) throw new Error(zscalerErrorMessage(res))
    const status = parseJson<{ status?: string }>(res.body)?.status
    return `ZIA reachable on tenant "${vanity}"${status ? ` (activation status: ${status})` : ''}`
  })
  checks.push(reachable)

  if (reachable.passed) {
    const specs = extractAdminUserSpecs(ctx.canvas).filter((s) => s.loginName)
    if (specs.length > 0) {
      const live = await listAdminUsers(client)
      const loginNames = new Set(live.map((u) => u.loginName))
      for (const spec of specs) {
        checks.push({
          name: `admin_user:${spec.loginName}`,
          passed: loginNames.has(spec.loginName),
          message: loginNames.has(spec.loginName)
            ? `Admin user "${spec.loginName}" is present`
            : `Admin user "${spec.loginName}" does not exist in the tenant`,
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
