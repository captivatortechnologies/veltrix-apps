import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildJamfClient } from '../../lib/jamfApi'
import { listComputerGroups, type ComputerGroupRef } from '../smart-computer-groups/deploy'
import { groupKey, indexGroupsByName } from '../smart-computer-groups/validate'
import { extractStaticGroupSpecs } from './validate'

/**
 * Health check for Jamf Pro static-group configuration:
 *   1. Jamf Pro Classic API reachability + credential validity (a groups list)
 *   2. Every declared group (by name) still exists as a STATIC group in the
 *      tenant — flags a group someone converted to smart outside Veltrix
 * Score is the percentage of passed checks (0–100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildJamfClient(ctx.component, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'jamf_credential', passed: false, message: built.error }] }
  }
  const { client } = built

  const specs = extractStaticGroupSpecs(ctx.canvas).filter((s) => s.name)

  const reachable = await timedCheck('jamf_reachable', async () => {
    const live = await listComputerGroups(client)
    return { message: `Jamf Pro Classic API reachable at ${client.classicBaseUrl}`, live }
  })
  checks.push({ name: reachable.name, passed: reachable.passed, message: reachable.message, latencyMs: reachable.latencyMs })

  if (reachable.passed && reachable.live) {
    const byName = indexGroupsByName(reachable.live.filter((g) => !g.isSmart))
    for (const spec of specs) {
      const found = byName.get(groupKey(spec.name))
      checks.push({
        name: `group:${spec.name}`,
        passed: !!found,
        message: found ? `Static group "${spec.name}" is present` : `Static group "${spec.name}" is missing`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length === 0 ? 0 : Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}

async function timedCheck(
  name: string,
  fn: () => Promise<{ message: string; live?: ComputerGroupRef[] }>,
): Promise<{ name: string; passed: boolean; message: string; latencyMs: number; live?: ComputerGroupRef[] }> {
  const start = Date.now()
  try {
    const { message, live } = await fn()
    return { name, passed: true, message, latencyMs: Date.now() - start, live }
  } catch (error) {
    return { name, passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start }
  }
}
