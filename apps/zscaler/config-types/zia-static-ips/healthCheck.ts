import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildZscalerClient, parseJson, zscalerErrorMessage } from '../../lib/zscaler'
import { listStaticIps } from './deploy'
import { extractStaticIpSpecs } from './validate'

/**
 * Health check for static IP configuration:
 *   1. ZIA API reachability + credential validity (GET /status)
 *   2. Every declared static IP still exists in the tenant
 * Score is the percentage of passed checks (0–100).
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
    const specs = extractStaticIpSpecs(ctx.canvas).filter((s) => s.ipAddress)
    if (specs.length > 0) {
      const live = await listStaticIps(client)
      const ips = new Set(live.map((s) => s.ipAddress))
      for (const spec of specs) {
        checks.push({
          name: `static-ip:${spec.ipAddress}`,
          passed: ips.has(spec.ipAddress),
          message: ips.has(spec.ipAddress)
            ? `Static IP "${spec.ipAddress}" is present`
            : `Static IP "${spec.ipAddress}" does not exist in the tenant`,
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
