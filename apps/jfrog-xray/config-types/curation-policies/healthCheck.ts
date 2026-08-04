import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildXrayClient } from '../../lib/xrayApi'
import { listCurationPolicies } from './deploy'
import { extractCurationPolicySpecs, findPolicy, type XrayCurationPolicy } from './_shared'

/**
 * Health check for the curation-policies configuration:
 *   1. Xray reachability + credential validity (`GET /api/v1/curation/policies`)
 *   2. Every declared policy (by name) still exists in the tenant
 * Score is the percentage of passed checks (0–100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildXrayClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'xray_credential', passed: false, message: built.error }] }
  }
  const { client, host } = built

  const specs = extractCurationPolicySpecs(ctx.canvas).filter((s) => s.name)

  const started = Date.now()
  let live: XrayCurationPolicy[] | null = null
  try {
    live = await listCurationPolicies(client)
    checks.push({ name: 'xray_reachable', passed: true, message: `Xray reachable at ${host}`, latencyMs: Date.now() - started })
  } catch (error) {
    checks.push({
      name: 'xray_reachable',
      passed: false,
      message: error instanceof Error ? error.message : 'Check failed',
      latencyMs: Date.now() - started,
    })
  }

  if (live) {
    for (const spec of specs) {
      const found = findPolicy(live, spec.name)
      checks.push({
        name: `policy:${spec.name}`,
        passed: Boolean(found),
        message: found ? `Curation policy "${spec.name}" is present` : `Curation policy "${spec.name}" is missing`,
      })
      if (found) {
        const liveEnabled = found.enabled !== false
        if (liveEnabled !== spec.enabled) {
          checks.push({
            name: `policy:${spec.name}:enabled`,
            passed: false,
            message: `Curation policy "${spec.name}" is ${liveEnabled ? 'enabled' : 'disabled'} but the configuration declares ${spec.enabled ? 'enabled' : 'disabled'}`,
          })
        }
      }
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length === 0 ? 0 : Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
