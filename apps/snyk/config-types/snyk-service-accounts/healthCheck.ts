import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildSnykClient } from '../../lib/snyk'
import { listServiceAccounts } from './deploy'
import { extractServiceAccountSpecs, saKey } from './validate'

/**
 * Health check for service-account configuration:
 *   1. Snyk API reachability + token/org validity (a service-accounts list)
 *   2. Every declared service account still exists (matched by name)
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
  let live: Awaited<ReturnType<typeof listServiceAccounts>> | null = null
  try {
    live = await listServiceAccounts(client)
    checks.push({ name: 'snyk_reachable', passed: true, message: `Snyk API reachable at ${host}`, latencyMs: Date.now() - start })
  } catch (error) {
    checks.push({
      name: 'snyk_reachable',
      passed: false,
      message: error instanceof Error ? error.message : 'Check failed',
      latencyMs: Date.now() - start,
    })
  }

  if (live) {
    const names = new Set(live.filter((a) => a.attributes?.name).map((a) => saKey(a.attributes!.name as string)))
    for (const spec of extractServiceAccountSpecs(ctx.canvas).filter((s) => s.name)) {
      const present = names.has(saKey(spec.name))
      checks.push({
        name: `service_account:${spec.name}`,
        passed: present,
        message: present ? `Service account "${spec.name}" is present` : `Service account "${spec.name}" is missing`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
