import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildCheckpointClient } from '../../lib/checkpointApi'
import { listAllServices } from './deploy'
import { extractServiceSpecs, serviceKey, type LiveService, type ServiceProtocol } from './validate'

/**
 * Health check for Check Point service-objects configuration:
 *   1. Management API reachability + credential validity (login + one
 *      show-services-{tcp,udp} per protocol actually declared)
 *   2. Every declared service (by name + protocol) still exists
 * Logs out at the end without publishing or discarding — read-only. Score is
 * the percentage of passed checks (0–100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildCheckpointClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'checkpoint_credential', passed: false, message: built.error }] }
  }
  const { client, host } = built

  const started = Date.now()
  const login = await client.login()
  if (login.error) {
    return { healthy: false, score: 0, checks: [{ name: 'checkpoint_login', passed: false, message: login.error }] }
  }

  const specs = extractServiceSpecs(ctx.canvas).filter((s) => s.name)
  const protocols = Array.from(new Set(specs.map((s) => s.protocol))) as ServiceProtocol[]
  const liveByProtocol = new Map<ServiceProtocol, LiveService[]>()
  let reachable = true

  try {
    for (const protocol of protocols.length > 0 ? protocols : (['tcp'] as ServiceProtocol[])) {
      liveByProtocol.set(protocol, await listAllServices(client, protocol))
    }
    checks.push({
      name: 'checkpoint_reachable',
      passed: true,
      message: `Reached the Check Point Management API at ${host}`,
      latencyMs: Date.now() - started,
    })
  } catch (error) {
    reachable = false
    checks.push({
      name: 'checkpoint_reachable',
      passed: false,
      message: error instanceof Error ? error.message : 'show-services failed',
      latencyMs: Date.now() - started,
    })
  } finally {
    await client.logout()
  }

  if (reachable) {
    for (const spec of specs) {
      const live = liveByProtocol.get(spec.protocol) ?? []
      const present = live.some((s) => s.name && serviceKey(s.name) === serviceKey(spec.name))
      checks.push({
        name: `service:${spec.name}`,
        passed: present,
        message: present
          ? `Service "${spec.name}" (${spec.protocol}) is present`
          : `Service "${spec.name}" (${spec.protocol}) is missing`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length === 0 ? 0 : Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
