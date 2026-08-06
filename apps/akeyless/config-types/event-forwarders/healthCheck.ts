import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildAkeylessClient, akeylessErrorMessage } from '../../lib/akeyless'
import { getEventForwarder } from './deploy'
import { extractEventForwarderSpecs } from './validate'

/**
 * Health check for event-forwarder configuration:
 *   1. Akeyless reachability + credential validity. There is no list
 *      endpoint for this object type (see canvas.yaml header), so this
 *      probes the generic, low-privilege /list-auth-methods endpoint
 *      instead - proving the Access ID/Key is valid before checking
 *      individual forwarders by name.
 *   2. Every declared forwarder still exists, matched by name, enabled and
 *      with its live type still matching the declared type
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildAkeylessClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'akeyless_credential', passed: false, message: built.error }] }
  }
  const { client, baseUrl } = built

  const specs = extractEventForwarderSpecs(ctx.canvas).filter((s) => s.name && s.type)

  const reachable = await timedCheck('akeyless_reachable', async () => {
    const res = await client.request('/list-auth-methods')
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
        await timedCheck(`event-forwarder:${spec.name}`, async () => {
          const live = await getEventForwarder(client, spec.name)
          if (!live) throw new Error(`Event forwarder "${spec.name}" does not exist in the account`)
          if (live.noti_forwarder_type && live.noti_forwarder_type !== spec.type) {
            throw new Error(`Event forwarder "${spec.name}" is type "${live.noti_forwarder_type}", expected "${spec.type}"`)
          }
          if (live.is_enabled === false) throw new Error(`Event forwarder "${spec.name}" exists but is disabled`)
          return `Event forwarder "${spec.name}" is present and enabled (${spec.type})`
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
