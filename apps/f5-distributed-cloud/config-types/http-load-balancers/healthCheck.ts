import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildF5xcClient, f5xcErrorMessage } from '../../lib/f5xc'
import { extractHttpLoadBalancerSpecs } from './validate'

const OBJECT_PLURAL = 'http_loadbalancers'

/**
 * Health check for HTTP load balancer configuration:
 *   1. Namespace reachability + API Token validity
 *   2. Every declared HTTP load balancer still exists in the namespace (re-fetched by name)
 * Score is the percentage of passed checks (0-100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildF5xcClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return {
      healthy: false,
      score: 0,
      checks: [{ name: 'f5xc_credential', passed: false, message: built.error }],
    }
  }
  const { client, tenantHost, namespace } = built

  const reachable = await timedCheck('f5xc_reachable', async () => {
    const res = await client.request('GET', `/${OBJECT_PLURAL}`)
    if (res.status === 401 || res.status === 403) {
      throw new Error('F5 Distributed Cloud rejected the API Token - check the credential and its RBAC role')
    }
    if (!res.ok) throw new Error(f5xcErrorMessage(res))
    return `F5 XC tenant ${tenantHost} namespace "${namespace}" reachable`
  })
  checks.push(reachable)

  if (reachable.passed) {
    const specs = extractHttpLoadBalancerSpecs(ctx.canvas).filter((s) => s.name)
    for (const spec of specs) {
      checks.push(
        await timedCheck(`http_loadbalancer:${spec.name}`, async () => {
          const live = await client.get(OBJECT_PLURAL, spec.name)
          if (!live) throw new Error(`HTTP Load Balancer "${spec.name}" does not exist in namespace "${namespace}"`)
          return `HTTP Load Balancer "${spec.name}" is present`
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
    return {
      name,
      passed: false,
      message: error instanceof Error ? error.message : 'Check failed',
      latencyMs: Date.now() - start,
    }
  }
}
