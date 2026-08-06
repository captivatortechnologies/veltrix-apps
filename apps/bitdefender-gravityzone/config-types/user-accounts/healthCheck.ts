import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildGravityZoneClient } from '../../lib/gravityZone'
import { getApiKeyDetails } from '../../lib/gravityZoneApi'
import { accountEmail, extractUserAccountSpecs, listAllAccounts, userAccountKey } from './_shared'

/**
 * Health check for user account configuration:
 *   1. GravityZone API reachability + API key validity
 *   2. Every declared email still exists as a live account
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
    checks.push({ name: 'gravityzone_reachable', passed: false, message: error instanceof Error ? error.message : 'GravityZone API unreachable', latencyMs: Date.now() - started })
    return { healthy: false, score: 0, checks }
  }

  const specs = extractUserAccountSpecs(ctx.canvas).filter((s) => s.email)
  const listStarted = Date.now()
  try {
    const live = await listAllAccounts(client)
    const liveEmails = new Set(live.filter((a) => accountEmail(a)).map((a) => userAccountKey(accountEmail(a))))
    for (const spec of specs) {
      const present = liveEmails.has(userAccountKey(spec.email))
      checks.push({
        name: `user-account:${spec.email}`,
        passed: present,
        message: present ? `Account "${spec.email}" is present.` : `Account "${spec.email}" is missing.`,
        latencyMs: Date.now() - listStarted,
      })
    }
  } catch (error) {
    checks.push({ name: 'user-accounts:list', passed: false, message: error instanceof Error ? error.message : 'Failed to list accounts', latencyMs: Date.now() - listStarted })
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length === 0 ? 0 : Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
