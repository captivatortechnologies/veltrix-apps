import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildXrayClient } from '../../lib/xrayApi'
import { customIssueReadPath } from './deploy'
import { extractCustomIssueSpecs } from './_shared'

/**
 * Health check for the custom-issues configuration:
 *   1. Xray reachability + credential validity — probed via the first declared
 *      issue's read call (this object has no list-all endpoint; see deploy.ts).
 *   2. Every declared issue (by id) still exists in the tenant.
 * Score is the percentage of passed checks (0–100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildXrayClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'xray_credential', passed: false, message: built.error }] }
  }
  const { client, host } = built

  const specs = extractCustomIssueSpecs(ctx.canvas).filter((s) => s.id)
  if (specs.length === 0) {
    return { healthy: true, score: 100, checks: [{ name: 'xray_reachable', passed: true, message: `No custom issues declared for ${host}` }] }
  }

  const started = Date.now()
  let reachable = false
  for (const spec of specs) {
    const res = await client.request('GET', customIssueReadPath(spec.id))
    if (checks.length === 0) {
      // The first call also proves reachability + auth, regardless of whether this particular issue exists.
      reachable = res.status > 0
      checks.push({
        name: 'xray_reachable',
        passed: reachable,
        message: reachable ? `Xray reachable at ${host}` : `Could not reach Xray at ${host}`,
        latencyMs: Date.now() - started,
      })
      if (!reachable) break
    }
    checks.push({
      name: `custom-issue:${spec.id}`,
      passed: res.ok,
      message: res.ok ? `Custom issue "${spec.id}" is present` : `Custom issue "${spec.id}" is missing`,
    })
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length === 0 ? 0 : Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
