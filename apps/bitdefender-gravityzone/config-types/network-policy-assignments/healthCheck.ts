import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildGravityZoneClient } from '../../lib/gravityZone'
import { getApiKeyDetails, getManagedEndpointDetails } from '../../lib/gravityZoneApi'
import { extractPolicyAssignmentSpecs } from './_shared'

/**
 * Health check for policy assignments:
 *   1. GravityZone API reachability + API key validity
 *   2. Every declared target endpoint id is still reachable
 * This does not (and cannot, per this app's research — see README.md "Known
 * limitations") confirm the target's CURRENT policy matches what was
 * assigned; it confirms the assignment's targets still exist.
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

  const specs = extractPolicyAssignmentSpecs(ctx.canvas).filter((s) => s.assignmentName)
  for (const spec of specs) {
    const checkStarted = Date.now()
    let missing = 0
    for (const targetId of spec.targetIds) {
      const details = await getManagedEndpointDetails(client, targetId)
      if (!details) missing++
    }
    const passed = missing === 0
    checks.push({
      name: `policy-assignment:${spec.assignmentName}`,
      passed,
      message: passed
        ? `All ${spec.targetIds.length} target(s) for "${spec.assignmentName}" are reachable.`
        : `${missing} of ${spec.targetIds.length} target(s) for "${spec.assignmentName}" could not be found.`,
      latencyMs: Date.now() - checkStarted,
    })
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length === 0 ? 0 : Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
