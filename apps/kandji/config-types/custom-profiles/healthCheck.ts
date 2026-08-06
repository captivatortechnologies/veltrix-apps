import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildKandjiClient } from '../../lib/kandjiApi'
import { listCustomProfiles } from './deploy'
import { customProfileKey, extractCustomProfileSpecs, indexCustomProfilesByName, type LiveCustomProfile } from './validate'

export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildKandjiClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'kandji_credential', passed: false, message: built.error }] }
  }
  const { client, baseUrl } = built

  const specs = extractCustomProfileSpecs(ctx.canvas).filter((s) => s.name)

  const reachable = await timedCheck('kandji_reachable', async () => {
    const live = await listCustomProfiles(client)
    return { message: `Kandji reachable at ${baseUrl}`, live }
  })
  checks.push({ name: reachable.name, passed: reachable.passed, message: reachable.message, latencyMs: reachable.latencyMs })

  if (reachable.passed && reachable.live) {
    const byName = indexCustomProfilesByName(reachable.live)
    for (const spec of specs) {
      const present = byName.has(customProfileKey(spec.name))
      checks.push({
        name: `custom-profile:${spec.name}`,
        passed: present,
        message: present ? `Custom Profile "${spec.name}" is present` : `Custom Profile "${spec.name}" is missing`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length === 0 ? 0 : Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}

async function timedCheck(
  name: string,
  fn: () => Promise<{ message: string; live?: LiveCustomProfile[] }>,
): Promise<{ name: string; passed: boolean; message: string; latencyMs: number; live?: LiveCustomProfile[] }> {
  const start = Date.now()
  try {
    const { message, live } = await fn()
    return { name, passed: true, message, latencyMs: Date.now() - start, live }
  } catch (error) {
    return { name, passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start }
  }
}
