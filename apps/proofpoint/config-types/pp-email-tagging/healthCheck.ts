import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildPPClient } from '../../lib/proofpoint'
import { extractEmailTaggingSpec, getEmailTagging, specFromBody } from './validate'

/**
 * Health check for Email Tagging Settings:
 *   1. Essentials API reachability + credential/org validity (read the settings)
 *   2. The full declared settings object matches the live value
 * Score is the percentage of passed checks (0–100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildPPClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'pp_credential', passed: false, message: built.error }] }
  }
  const { client, orgDomain } = built

  const spec = extractEmailTaggingSpec(ctx.canvas)
  const start = Date.now()

  try {
    const live = specFromBody(await getEmailTagging(client))
    checks.push({ name: 'pp_reachable', passed: true, message: `Proofpoint Essentials reachable — org "${orgDomain}"`, latencyMs: Date.now() - start })

    const matches = (Object.keys(spec) as Array<keyof typeof spec>).every((key) => spec[key] === live[key])
    checks.push({
      name: 'email_tagging_settings',
      passed: matches,
      message: matches ? 'Email-tagging settings match the declared configuration' : 'Email-tagging settings drifted from the declared configuration',
    })
  } catch (error) {
    checks.push({
      name: 'pp_reachable',
      passed: false,
      message: error instanceof Error ? error.message : 'Check failed',
      latencyMs: Date.now() - start,
    })
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length > 0 ? Math.round((passedCount / checks.length) * 100) : 0
  return { healthy: passedCount === checks.length, score, checks }
}
