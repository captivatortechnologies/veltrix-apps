import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildGravityZoneClient } from '../../lib/gravityZone'
import { getApiKeyDetails, getCompanyDetails } from '../../lib/gravityZoneApi'
import { extractCompanyProfileSpecs } from './_shared'

/**
 * Health check for company profile configuration:
 *   1. GravityZone API reachability + API key validity (general.getApiKeyDetails)
 *   2. Every declared companyId (or the API key's own company when blank)
 *      resolves via companies.getCompanyDetails
 * Score is the percentage of passed checks (0-100).
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
    checks.push({
      name: 'gravityzone_reachable',
      passed: false,
      message: error instanceof Error ? error.message : 'GravityZone API unreachable',
      latencyMs: Date.now() - started,
    })
    return { healthy: false, score: 0, checks }
  }

  const specs = extractCompanyProfileSpecs(ctx.canvas)
  for (const spec of specs) {
    const label = spec.companyId || '(own company)'
    const checkStarted = Date.now()
    try {
      await getCompanyDetails(client, spec.companyId || undefined)
      checks.push({ name: `company-profile:${label}`, passed: true, message: `Company "${label}" resolved.`, latencyMs: Date.now() - checkStarted })
    } catch (error) {
      checks.push({
        name: `company-profile:${label}`,
        passed: false,
        message: error instanceof Error ? error.message : `Company "${label}" could not be resolved.`,
        latencyMs: Date.now() - checkStarted,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length === 0 ? 0 : Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
