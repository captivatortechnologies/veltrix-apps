import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildXrayClient } from '../../lib/xrayApi'
import { POLICIES_PATH } from './deploy'
import { extractPolicySpecs, findPolicy, type XraySecurityPolicy } from './_shared'

/**
 * Health check for the security-policies configuration:
 *   1. Xray reachability + credential validity (`GET /api/v2/policies`)
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

  const specs = extractPolicySpecs(ctx.canvas).filter((s) => s.name)

  const started = Date.now()
  let live: XraySecurityPolicy[] | null = null
  try {
    live = await client.getJson<XraySecurityPolicy[]>(POLICIES_PATH)
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
      const present = Boolean(findPolicy(live, spec.name))
      checks.push({
        name: `policy:${spec.name}`,
        passed: present,
        message: present ? `Security policy "${spec.name}" is present` : `Security policy "${spec.name}" is missing`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length === 0 ? 0 : Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
