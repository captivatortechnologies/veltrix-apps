import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildS1Client, MISSING_SCOPE_MESSAGE } from '../../lib/s1'
import { listRestrictions } from './deploy'
import { extractHashSpecs, hashKey, type LiveRestriction } from './validate'

/**
 * Health check for hash-allowlist configuration:
 *   1. SentinelOne API reachability + credential/scope validity (a scoped list)
 *   2. Every declared hash (SHA1, osType) is still allowlisted at the scope
 * Score is the percentage of passed checks (0–100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildS1Client(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 's1_credential', passed: false, message: built.error }] }
  }
  const { client, consoleUrl } = built
  if (!client.hasScope) {
    return { healthy: false, score: 0, checks: [{ name: 's1_scope', passed: false, message: MISSING_SCOPE_MESSAGE }] }
  }

  const specs = extractHashSpecs(ctx.canvas).filter((s) => s.sha1 && s.osType)

  const reachable = await timedCheck('s1_reachable', async () => {
    const live = await listRestrictions(client)
    return { message: `SentinelOne reachable at ${consoleUrl} (${client.currentScope} scope)`, live }
  })
  checks.push({ name: reachable.name, passed: reachable.passed, message: reachable.message, latencyMs: reachable.latencyMs })

  if (reachable.passed && reachable.live) {
    const keys = new Set(
      reachable.live
        .filter((e) => e.value && e.osType)
        .map((e) => hashKey({ sha1: e.value as string, osType: e.osType as string })),
    )
    for (const spec of specs) {
      const present = keys.has(hashKey(spec))
      checks.push({
        name: `hash:${spec.sha1} (${spec.osType})`,
        passed: present,
        message: present ? `Hash "${spec.sha1}" is allowlisted` : `Hash "${spec.sha1}" is not allowlisted`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}

async function timedCheck(
  name: string,
  fn: () => Promise<{ message: string; live?: LiveRestriction[] }>,
): Promise<{ name: string; passed: boolean; message: string; latencyMs: number; live?: LiveRestriction[] }> {
  const start = Date.now()
  try {
    const { message, live } = await fn()
    return { name, passed: true, message, latencyMs: Date.now() - start, live }
  } catch (error) {
    return { name, passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start }
  }
}
