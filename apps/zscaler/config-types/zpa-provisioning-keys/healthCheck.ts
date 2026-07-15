import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildZscalerClient, MISSING_CUSTOMER_ID_MESSAGE, zscalerErrorMessage } from '../../lib/zscaler'
import { listProvisioningKeys } from './deploy'
import { extractProvisioningKeySpecs } from './validate'

/**
 * Health check for provisioning key configuration:
 *   1. ZPA API reachability + credential/customerId validity (probe the
 *      enrollment cert endpoint the keys depend on, falling back to an App
 *      Connector group probe)
 *   2. Every declared provisioning key still exists in its association type
 * Score is the percentage of passed checks (0–100).
 *
 * ⚠ Existence only — the key SECRET is never fetched or inspected.
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
    // Prefer the enrollment cert endpoint (v2) since keys depend on it.
    let res = await client.zpa('GET', '/enrollmentCert', { query: { page: 1, pagesize: 1 }, version: 'v2' })
    if (res.status === 401 || res.status === 403) {
      throw new Error('Zscaler rejected the OneAPI credential (check the API client id/secret and its ZPA roles)')
    }
    if (!res.ok) {
      // Older tenants restrict/omit the v2 enrollment cert endpoint — fall back
      // to a plain App Connector group probe to confirm reachability.
      res = await client.zpa('GET', '/appConnectorGroup', { query: { page: 1, pagesize: 1 } })
      if (res.status === 401 || res.status === 403) {
        throw new Error('Zscaler rejected the OneAPI credential (check the API client id/secret and its ZPA roles)')
      }
      if (!res.ok) throw new Error(zscalerErrorMessage(res))
    }
    return `ZPA reachable on tenant "${vanity}"`
  })
  checks.push(reachable)

  if (reachable.passed) {
    const specs = extractProvisioningKeySpecs(ctx.canvas).filter((s) => s.name && s.associationType)
    if (specs.length > 0) {
      // Re-list once per association type, then confirm each declared key.
      const namesByType = new Map<string, Set<string>>()
      for (const spec of specs) {
        let names = namesByType.get(spec.associationType)
        if (!names) {
          const live = await listProvisioningKeys(client, spec.associationType)
          names = new Set(live.map((k) => k.name).filter((n): n is string => !!n))
          namesByType.set(spec.associationType, names)
        }
        const present = names.has(spec.name)
        checks.push({
          name: `provisioningKey:${spec.associationType}/${spec.name}`,
          passed: present,
          message: present
            ? `Provisioning key "${spec.name}" (${spec.associationType}) is present`
            : `Provisioning key "${spec.name}" (${spec.associationType}) does not exist in the tenant`,
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
