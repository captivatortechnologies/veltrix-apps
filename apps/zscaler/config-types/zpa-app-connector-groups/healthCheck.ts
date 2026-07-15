import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildZscalerClient, MISSING_CUSTOMER_ID_MESSAGE, zscalerErrorMessage } from '../../lib/zscaler'
import { listAppConnectorGroups } from './deploy'
import { extractAppConnectorGroupSpecs } from './validate'

/**
 * Health check for App Connector group configuration:
 *   1. ZPA API reachability + credential/customerId validity
 *   2. Every declared App Connector group still exists in the tenant
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
  if (!client.hasCustomerId) {
    return {
      healthy: false,
      score: 0,
      checks: [{ name: 'zpa_customer_id', passed: false, message: MISSING_CUSTOMER_ID_MESSAGE }],
    }
  }

  const reachable = await timedCheck('zpa_reachable', async () => {
    const res = await client.zpa('GET', '/appConnectorGroup', { query: { page: 1, pagesize: 1 } })
    if (res.status === 401 || res.status === 403) {
      throw new Error('Zscaler rejected the OneAPI credential (check the API client id/secret and its ZPA roles)')
    }
    if (!res.ok) throw new Error(zscalerErrorMessage(res))
    return `ZPA reachable on tenant "${vanity}"`
  })
  checks.push(reachable)

  if (reachable.passed) {
    const specs = extractAppConnectorGroupSpecs(ctx.canvas).filter((s) => s.name)
    if (specs.length > 0) {
      const live = await listAppConnectorGroups(client)
      const names = new Set(live.map((g) => g.name))
      for (const spec of specs) {
        checks.push({
          name: `appConnectorGroup:${spec.name}`,
          passed: names.has(spec.name),
          message: names.has(spec.name)
            ? `App Connector group "${spec.name}" is present`
            : `App Connector group "${spec.name}" does not exist in the tenant`,
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
