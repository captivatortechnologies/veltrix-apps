// =============================================================================
// Health check: is the Defender machines API reachable, and does each declared
// device still carry its declared tags? Score is the percentage of checks passed.
// =============================================================================

import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildMdeClient } from '../../lib/mde'
import { resolveMachines } from './deploy'
import { extractMachineTagSpecs, tagKey } from './validate'

export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []
  const built = buildMdeClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'mde_credential', passed: false, message: built.error }] }
  }
  const { client, apiHost } = built

  const specs = extractMachineTagSpecs(ctx.canvas).filter((s) => s.deviceValue && s.tags.length > 0)

  const start = Date.now()
  let reachable = false
  try {
    const probe = await client.request('GET', '/machines', { query: { $top: 1 } })
    reachable = probe.ok || probe.status === 404
    checks.push({
      name: 'mde_reachable',
      passed: reachable,
      message: reachable ? `Defender machines API reachable at ${apiHost}` : `Defender machines API returned HTTP ${probe.status}`,
      latencyMs: Date.now() - start,
    })
  } catch (error) {
    checks.push({ name: 'mde_reachable', passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start })
  }

  if (reachable) {
    for (const spec of specs) {
      const resolved = await resolveMachines(client, spec)
      if (!resolved.ok) {
        checks.push({ name: `device:${spec.deviceValue}`, passed: false, message: `Failed to resolve device: ${resolved.error}` })
        continue
      }
      if (resolved.machines.length === 0) {
        checks.push({ name: `device:${spec.deviceValue}`, passed: false, message: 'Device not found' })
        continue
      }
      for (const machine of resolved.machines) {
        const deviceLabel = machine.computerDnsName ?? machine.id ?? spec.deviceValue
        const present = new Set((machine.machineTags ?? []).map(tagKey))
        for (const tag of spec.tags) {
          const has = present.has(tagKey(tag))
          checks.push({ name: `tag:${tag} on ${deviceLabel}`, passed: has, message: has ? 'Tag is present' : 'Tag is missing' })
        }
      }
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length > 0 ? Math.round((passedCount / checks.length) * 100) : 0
  return { healthy: passedCount === checks.length, score, checks }
}
