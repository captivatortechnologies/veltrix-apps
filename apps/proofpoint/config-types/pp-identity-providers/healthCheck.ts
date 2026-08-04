import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildPPClient } from '../../lib/proofpoint'
import { extractIdpSpecs, idpKey, listIdps, type LiveIdp } from './validate'

/**
 * Health check for Identity Provider configuration:
 *   1. Essentials API reachability + credential/org validity (an IDP list)
 *   2. Every declared IDP still exists in the org and its is_active matches
 * Score is the percentage of passed checks (0–100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildPPClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'pp_credential', passed: false, message: built.error }] }
  }
  const { client, orgDomain } = built

  const specs = extractIdpSpecs(ctx.canvas).filter((s) => s.name)

  const start = Date.now()
  let live: LiveIdp[] | null = null
  try {
    live = await listIdps(client)
    checks.push({ name: 'pp_reachable', passed: true, message: `Proofpoint Essentials reachable — org "${orgDomain}"`, latencyMs: Date.now() - start })
  } catch (error) {
    checks.push({
      name: 'pp_reachable',
      passed: false,
      message: error instanceof Error ? error.message : 'Check failed',
      latencyMs: Date.now() - start,
    })
  }

  if (live) {
    const byKey = new Map(live.filter((i) => i.name).map((i) => [idpKey(i.name as string), i]))
    for (const spec of specs) {
      const found = byKey.get(idpKey(spec.name))
      if (!found) {
        checks.push({ name: `idp:${spec.name}`, passed: false, message: `Identity Provider "${spec.name}" is missing` })
        continue
      }
      const activeMatches = (found.is_active ?? true) === spec.isActive
      checks.push({
        name: `idp:${spec.name}`,
        passed: activeMatches,
        message: activeMatches
          ? `Identity Provider "${spec.name}" is present (active=${spec.isActive})`
          : `Identity Provider "${spec.name}" active flag drifted (expected ${spec.isActive}, found ${found.is_active ?? true})`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length > 0 ? Math.round((passedCount / checks.length) * 100) : 0
  return { healthy: passedCount === checks.length, score, checks }
}
