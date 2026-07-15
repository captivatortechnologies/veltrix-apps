import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildZscalerClient, MISSING_CUSTOMER_ID_MESSAGE, zscalerErrorMessage } from '../../lib/zscaler'
import { listPolicyRules } from './deploy'
import { extractPolicyRuleSpecs, type LivePolicyRule } from './validate'

/**
 * Health check for policy rule configuration:
 *   1. ZPA API reachability + credential/customerId validity (probes the
 *      ACCESS_POLICY policy set, which every ZPA tenant has)
 *   2. Every declared rule still exists within its policy set
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
    const res = await client.zpa('GET', '/policySet/policyType/ACCESS_POLICY')
    if (res.status === 401 || res.status === 403) {
      throw new Error('Zscaler rejected the OneAPI credential (check the API client id/secret and its ZPA roles)')
    }
    if (!res.ok) throw new Error(zscalerErrorMessage(res))
    return `ZPA reachable on tenant "${vanity}"`
  })
  checks.push(reachable)

  if (reachable.passed) {
    const specs = extractPolicyRuleSpecs(ctx.canvas).filter((s) => s.name && s.policyType)
    if (specs.length > 0) {
      // List each targeted policy set once, then check membership per rule.
      const namesByType = new Map<string, Set<string> | null>()
      for (const type of new Set(specs.map((s) => s.policyType))) {
        try {
          const live = await listPolicyRules(client, type)
          namesByType.set(type, new Set(live.map((r: LivePolicyRule) => r.name).filter((n): n is string => !!n)))
        } catch {
          namesByType.set(type, null)
        }
      }
      for (const spec of specs) {
        const names = namesByType.get(spec.policyType)
        if (names == null) {
          checks.push({
            name: `rule:${spec.policyType}/${spec.name}`,
            passed: false,
            message: `Could not list ${spec.policyType} rules`,
          })
          continue
        }
        const present = names.has(spec.name)
        checks.push({
          name: `rule:${spec.policyType}/${spec.name}`,
          passed: present,
          message: present
            ? `Rule "${spec.name}" is present in ${spec.policyType}`
            : `Rule "${spec.name}" does not exist in ${spec.policyType}`,
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
