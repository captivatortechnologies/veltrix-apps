import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildGravityZoneClient } from '../../lib/gravityZone'
import { getApiKeyDetails, getPolicyDetails } from '../../lib/gravityZoneApi'
import { extractPolicyModuleStateSpecs } from './_shared'

/**
 * Health check for policy module state configuration:
 *   1. GravityZone API reachability + API key validity
 *   2. Every declared policyId still exists (policies.getPolicyDetails)
 * Does not (cannot, per this app's research) confirm the specific module
 * states themselves — see driftDetect.ts and README.md "Known limitations".
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildGravityZoneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'gravityzone_credential', passed: false, message: built.error }] }
  }
  const { client } = built

  const started = Date.now()
  try {
    await getApiKeyDetails(client)
    checks.push({ name: 'gravityzone_reachable', passed: true, message: 'GravityZone API reachable and API key accepted.', latencyMs: Date.now() - started })
  } catch (error) {
    checks.push({ name: 'gravityzone_reachable', passed: false, message: error instanceof Error ? error.message : 'GravityZone API unreachable', latencyMs: Date.now() - started })
    return { healthy: false, score: 0, checks }
  }

  const specs = extractPolicyModuleStateSpecs(ctx.canvas).filter((s) => s.policyId)
  for (const spec of specs) {
    const checkStarted = Date.now()
    const details = await getPolicyDetails(client, spec.policyId)
    const present = Boolean(details)
    checks.push({
      name: `policy-module-states:${spec.policyId}`,
      passed: present,
      message: present ? `Policy "${spec.policyId}" is present.` : `Policy "${spec.policyId}" is missing.`,
      latencyMs: Date.now() - checkStarted,
    })
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length === 0 ? 0 : Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
