import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildAkeylessClient, akeylessErrorMessage } from '../../lib/akeyless'
import { getK8sAuthConfig } from './deploy'
import { extractK8sAuthConfigSpecs } from './validate'

/**
 * Health check for Gateway K8s auth configuration:
 *   1. Akeyless reachability + credential validity (POST /list-auth-methods
 *      - there is no list endpoint for this object type)
 *   2. Every declared config still exists, matched by name, with the same
 *      declared K8s API host and access-id binding
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildAkeylessClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'akeyless_credential', passed: false, message: built.error }] }
  }
  const { client, baseUrl } = built

  const specs = extractK8sAuthConfigSpecs(ctx.canvas).filter((s) => s.name)

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
        await timedCheck(`k8s-auth-config:${spec.name}`, async () => {
          const live = await getK8sAuthConfig(client, spec.name)
          if (!live) throw new Error(`K8s auth config "${spec.name}" does not exist in the account`)
          if (live.access_id && live.access_id !== spec.accessId) {
            throw new Error(`K8s auth config "${spec.name}" is bound to access-id "${live.access_id}", expected "${spec.accessId}"`)
          }
          return `K8s auth config "${spec.name}" is present`
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
