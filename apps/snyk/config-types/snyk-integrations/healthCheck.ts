import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildSnykClient } from '../../lib/snyk'
import { listIntegrations } from './deploy'
import { extractIntegrationSpecs, integrationKey } from './validate'

/**
 * Health check for integration settings:
 *   1. Snyk API reachability + token/org validity (an integrations list)
 *   2. Every declared integration type is connected in the org
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

  const start = Date.now()
  let integrations: Record<string, string> | null = null
  try {
    integrations = await listIntegrations(client)
    checks.push({ name: 'snyk_reachable', passed: true, message: `Snyk API reachable at ${host}`, latencyMs: Date.now() - start })
  } catch (error) {
    checks.push({ name: 'snyk_reachable', passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start })
  }

  if (integrations) {
    for (const spec of extractIntegrationSpecs(ctx.canvas).filter((s) => s.integrationType)) {
      const present = Boolean(integrations[integrationKey(spec.integrationType)])
      checks.push({
        name: `integration:${spec.integrationType}`,
        passed: present,
        message: present ? `Integration "${spec.integrationType}" is connected` : `Integration "${spec.integrationType}" is not connected`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
