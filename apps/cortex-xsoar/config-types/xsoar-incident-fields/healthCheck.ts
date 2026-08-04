import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildXsoarClient } from '../../lib/xsoar'
import { buildFieldId, fieldsOfKind, listFields, type LiveField } from '../lib/xsoarFields'
import { extractFieldSpecs } from './validate'

const KIND = 'incident' as const

/**
 * Health check for incident-field configuration:
 *   1. XSOAR API reachability + credential validity (a field read)
 *   2. Every declared field still exists on the server
 * Score is the percentage of passed checks (0-100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildXsoarClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'xsoar_credential', passed: false, message: built.error }] }
  }
  const { client, serverUrl } = built

  const specs = extractFieldSpecs(ctx.canvas).filter((s) => s.cliName)

  const reachable = await timedCheck('xsoar_reachable', async () => {
    const live = fieldsOfKind(await listFields(client), KIND)
    return { message: `Cortex XSOAR reachable at ${serverUrl}`, live }
  })
  checks.push({ name: reachable.name, passed: reachable.passed, message: reachable.message, latencyMs: reachable.latencyMs })

  if (reachable.passed && reachable.live) {
    const ids = new Set(reachable.live.filter((f) => f.id).map((f) => f.id as string))
    for (const spec of specs) {
      const id = buildFieldId(KIND, spec.cliName)
      const present = ids.has(id)
      checks.push({
        name: `field:${spec.cliName}`,
        passed: present,
        message: present ? `Incident field "${spec.cliName}" is present` : `Incident field "${spec.cliName}" is missing`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}

async function timedCheck(
  name: string,
  fn: () => Promise<{ message: string; live?: LiveField[] }>,
): Promise<{ name: string; passed: boolean; message: string; latencyMs: number; live?: LiveField[] }> {
  const start = Date.now()
  try {
    const { message, live } = await fn()
    return { name, passed: true, message, latencyMs: Date.now() - start, live }
  } catch (error) {
    return { name, passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start }
  }
}
