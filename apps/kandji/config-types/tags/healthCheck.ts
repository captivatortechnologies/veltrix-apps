import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildKandjiClient } from '../../lib/kandjiApi'
import { listTags } from './deploy'
import { tagKey, extractTagSpecs, indexTagsByName, type LiveTag } from './validate'

export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildKandjiClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'kandji_credential', passed: false, message: built.error }] }
  }
  const { client, baseUrl } = built

  const specs = extractTagSpecs(ctx.canvas).filter((s) => s.name)

  const reachable = await timedCheck('kandji_reachable', async () => {
    const live = await listTags(client)
    return { message: `Kandji reachable at ${baseUrl}`, live }
  })
  checks.push({ name: reachable.name, passed: reachable.passed, message: reachable.message, latencyMs: reachable.latencyMs })

  if (reachable.passed && reachable.live) {
    const byName = indexTagsByName(reachable.live)
    for (const spec of specs) {
      const present = byName.has(tagKey(spec.name))
      checks.push({
        name: `tag:${spec.name}`,
        passed: present,
        message: present ? `Tag "${spec.name}" is present` : `Tag "${spec.name}" is missing`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length === 0 ? 0 : Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}

async function timedCheck(
  name: string,
  fn: () => Promise<{ message: string; live?: LiveTag[] }>,
): Promise<{ name: string; passed: boolean; message: string; latencyMs: number; live?: LiveTag[] }> {
  const start = Date.now()
  try {
    const { message, live } = await fn()
    return { name, passed: true, message, latencyMs: Date.now() - start, live }
  } catch (error) {
    return { name, passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start }
  }
}
