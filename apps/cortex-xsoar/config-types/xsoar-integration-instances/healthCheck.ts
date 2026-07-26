import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildXsoarClient } from '../../lib/xsoar'
import { listIntegrationInstances } from './deploy'
import { extractIntegrationInstanceSpecs, type LiveIntegrationInstance } from './validate'

/**
 * Health check for integration-instance configuration:
 *   1. XSOAR API reachability + credential validity (an integration search)
 *   2. Every declared instance still exists on the server
 * Score is the percentage of passed checks (0-100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildXsoarClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'xsoar_credential', passed: false, message: built.error }] }
  }
  const { client, serverUrl } = built

  const specs = extractIntegrationInstanceSpecs(ctx.canvas).filter((s) => s.name)

  const reachable = await timedCheck('xsoar_reachable', async () => {
    const live = await listIntegrationInstances(client)
    return { message: `Cortex XSOAR reachable at ${serverUrl}`, live }
  })
  checks.push({ name: reachable.name, passed: reachable.passed, message: reachable.message, latencyMs: reachable.latencyMs })

  if (reachable.passed && reachable.live) {
    const names = new Set(reachable.live.filter((i) => i.name).map((i) => i.name as string))
    for (const spec of specs) {
      const present = names.has(spec.name)
      checks.push({
        name: `instance:${spec.name}`,
        passed: present,
        message: present ? `Integration instance "${spec.name}" is present` : `Integration instance "${spec.name}" is missing`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}

async function timedCheck(
  name: string,
  fn: () => Promise<{ message: string; live?: LiveIntegrationInstance[] }>,
): Promise<{ name: string; passed: boolean; message: string; latencyMs: number; live?: LiveIntegrationInstance[] }> {
  const start = Date.now()
  try {
    const { message, live } = await fn()
    return { name, passed: true, message, latencyMs: Date.now() - start, live }
  } catch (error) {
    return { name, passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start }
  }
}
