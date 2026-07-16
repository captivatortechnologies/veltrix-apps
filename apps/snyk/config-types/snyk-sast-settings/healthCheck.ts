import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildSnykClient } from '../../lib/snyk'
import { readSastSettings } from './deploy'
import { extractSastSettings } from './validate'

/**
 * Health check for SAST settings:
 *   1. Snyk API reachability + token/org validity (a settings GET)
 *   2. The live sast_enabled matches the declared value
 * Score is the percentage of passed checks (0–100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildSnykClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'snyk_credential', passed: false, message: built.error }] }
  }
  const { client, host } = built
  if (!client.hasOrg) {
    return { healthy: false, score: 0, checks: [{ name: 'snyk_org', passed: false, message: 'No Snyk organization id set' }] }
  }

  const spec = extractSastSettings(ctx.canvas)
  const start = Date.now()
  try {
    const live = await readSastSettings(client)
    checks.push({ name: 'snyk_reachable', passed: true, message: `Snyk API reachable at ${host}`, latencyMs: Date.now() - start })
    const matches = (live?.sast_enabled ?? false) === spec.sastEnabled
    checks.push({
      name: 'sast_enabled',
      passed: matches,
      message: matches
        ? `Snyk Code is ${spec.sastEnabled ? 'enabled' : 'disabled'} as configured`
        : `Snyk Code is ${live?.sast_enabled ? 'enabled' : 'disabled'} but configuration expects ${spec.sastEnabled ? 'enabled' : 'disabled'}`,
    })
  } catch (error) {
    checks.push({ name: 'snyk_reachable', passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start })
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
