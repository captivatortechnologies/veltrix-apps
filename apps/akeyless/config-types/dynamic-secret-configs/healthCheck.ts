import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildAkeylessClient, akeylessErrorMessage } from '../../lib/akeyless'
import { getDynamicSecret, detectLiveType } from './deploy'
import { extractDynamicSecretSpecs } from './validate'

/**
 * Health check for dynamic secret producer configuration:
 *   1. Akeyless reachability + credential validity (POST /dynamic-secret-list)
 *   2. Every declared producer still exists, matched by name, with its live
 *      type still matching the declared type
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildAkeylessClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'akeyless_credential', passed: false, message: built.error }] }
  }
  const { client, baseUrl } = built

  const specs = extractDynamicSecretSpecs(ctx.canvas).filter((s) => s.name && s.type)

  const reachable = await timedCheck('akeyless_reachable', async () => {
    const res = await client.request('/dynamic-secret-list')
    if (res.status === 401 || res.status === 403) {
      throw new Error('Akeyless rejected the credentials (invalid Access ID/Key, or missing role permissions)')
    }
    if (!res.ok) throw new Error(akeylessErrorMessage(res))
    return `Akeyless (${baseUrl}) reachable`
  })
  checks.push(reachable)

  if (reachable.passed) {
    for (const spec of specs) {
      checks.push(
        await timedCheck(`dynamic-secret:${spec.name}`, async () => {
          const live = await getDynamicSecret(client, spec.name)
          if (!live) throw new Error(`Dynamic secret config "${spec.name}" does not exist in the account`)
          const liveType = detectLiveType(live)
          if (liveType !== 'unknown' && liveType !== spec.type) {
            throw new Error(`Dynamic secret config "${spec.name}" is type "${liveType}", expected "${spec.type}"`)
          }
          return `Dynamic secret config "${spec.name}" is present (${spec.type})`
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
