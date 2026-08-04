import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildWizClient } from '../../lib/wiz'
import { listIntegrations } from './deploy'
import { extractIntegrationSpecs, integrationKey, type LiveIntegration } from './validate'

/**
 * Health check for integration configuration:
 *   1. Wiz GraphQL reachability + credential validity (an integrations list)
 *   2. Every declared integration (by name) still exists
 * Score is the percentage of passed checks (0–100). Never checks credential
 * validity against the vendor (e.g. that a Jira password still works) — Wiz's
 * `params` is write-only and cannot be read back to verify.
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildWizClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'wiz_credential', passed: false, message: built.error }] }
  }
  const { client, graphqlUrl } = built

  const specs = extractIntegrationSpecs(ctx.canvas).filter((s) => s.name && s.integrationType)

  const reachable = await timedCheck('wiz_reachable', async () => {
    const live = await listIntegrations(client)
    return { message: `Wiz reachable at ${graphqlUrl}`, live }
  })
  checks.push({ name: reachable.name, passed: reachable.passed, message: reachable.message, latencyMs: reachable.latencyMs })

  if (reachable.passed && reachable.live) {
    const names = new Set(reachable.live.filter((i) => i.name).map((i) => integrationKey(i.name as string)))
    for (const spec of specs) {
      const present = names.has(integrationKey(spec.name))
      checks.push({
        name: `integration:${spec.name}`,
        passed: present,
        message: present ? `Integration "${spec.name}" is present` : `Integration "${spec.name}" is missing`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length === 0 ? 0 : Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}

async function timedCheck(
  name: string,
  fn: () => Promise<{ message: string; live?: LiveIntegration[] }>,
): Promise<{ name: string; passed: boolean; message: string; latencyMs: number; live?: LiveIntegration[] }> {
  const start = Date.now()
  try {
    const { message, live } = await fn()
    return { name, passed: true, message, latencyMs: Date.now() - start, live }
  } catch (error) {
    return { name, passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start }
  }
}
