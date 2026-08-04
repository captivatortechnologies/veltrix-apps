import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildXsoarClient } from '../../lib/xsoar'
import { CLASSIFIER_TYPE, searchClassifications, type LiveClassification } from '../lib/xsoarClassification'
import { extractClassifierSpecs } from './validate'

/**
 * Health check for classifier configuration:
 *   1. XSOAR API reachability + credential validity (a classifier search)
 *   2. Every declared classifier still exists on the server
 * Score is the percentage of passed checks (0-100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildXsoarClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'xsoar_credential', passed: false, message: built.error }] }
  }
  const { client, serverUrl } = built

  const specs = extractClassifierSpecs(ctx.canvas).filter((s) => s.id)

  const reachable = await timedCheck('xsoar_reachable', async () => {
    const live = await searchClassifications(client)
    return { message: `Cortex XSOAR reachable at ${serverUrl}`, live }
  })
  checks.push({ name: reachable.name, passed: reachable.passed, message: reachable.message, latencyMs: reachable.latencyMs })

  if (reachable.passed && reachable.live) {
    const ids = new Set(
      reachable.live.filter((c) => c.type === CLASSIFIER_TYPE && c.id).map((c) => c.id as string),
    )
    for (const spec of specs) {
      const present = ids.has(spec.id)
      checks.push({
        name: `classifier:${spec.id}`,
        passed: present,
        message: present ? `Classifier "${spec.id}" is present` : `Classifier "${spec.id}" is missing`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}

async function timedCheck(
  name: string,
  fn: () => Promise<{ message: string; live?: LiveClassification[] }>,
): Promise<{ name: string; passed: boolean; message: string; latencyMs: number; live?: LiveClassification[] }> {
  const start = Date.now()
  try {
    const { message, live } = await fn()
    return { name, passed: true, message, latencyMs: Date.now() - start, live }
  } catch (error) {
    return { name, passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start }
  }
}
