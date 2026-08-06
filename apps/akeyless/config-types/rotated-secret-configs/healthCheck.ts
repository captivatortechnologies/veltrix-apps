import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildAkeylessClient, akeylessErrorMessage } from '../../lib/akeyless'
import { listRotatedSecrets } from './deploy'
import { extractRotatedSecretSpecs } from './validate'

/**
 * Health check for rotated secret configuration:
 *   1. Akeyless reachability + credential validity (POST /rotated-secret-list)
 *   2. Every declared config still exists and is active, matched by name
 *      (existence-only - see canvas.yaml header for why field-level
 *      verification is not possible for this config type)
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildAkeylessClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'akeyless_credential', passed: false, message: built.error }] }
  }
  const { client, baseUrl } = built

  const specs = extractRotatedSecretSpecs(ctx.canvas).filter((s) => s.name && s.type)

  const reachable = await timedCheck('akeyless_reachable', async () => {
    const res = await client.request('/rotated-secret-list')
    if (res.status === 401 || res.status === 403) {
      throw new Error('Akeyless rejected the credentials (invalid Access ID/Key, or missing role permissions)')
    }
    if (!res.ok) throw new Error(akeylessErrorMessage(res))
    return `Akeyless (${baseUrl}) reachable`
  })
  checks.push(reachable)

  if (reachable.passed) {
    const live = await listRotatedSecrets(client)
    const liveByName = new Map(live.map((p) => [p.name, p]))
    for (const spec of specs) {
      checks.push(
        await timedCheck(`rotated-secret:${spec.name}`, async () => {
          const producer = liveByName.get(spec.name)
          if (!producer) throw new Error(`Rotated secret config "${spec.name}" does not exist in the account`)
          if (producer.active === false) throw new Error(`Rotated secret config "${spec.name}" exists but is not active`)
          return `Rotated secret config "${spec.name}" is present and active`
        }),
      )
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}

async function timedCheck(name: string, fn: () => Promise<string>): Promise<HealthCheckResult['checks'][0]> {
  const start = Date.now()
  try {
    const message = await fn()
    return { name, passed: true, message, latencyMs: Date.now() - start }
  } catch (error) {
    return { name, passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start }
  }
}
