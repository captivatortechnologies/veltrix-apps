import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildOnePasswordClient, scimErrorMessage } from '../../lib/onePassword'
import { listGroups } from './deploy'
import { extractGroupSpecs, type LiveGroup } from './validate'

/**
 * Health check for group configuration:
 *   1. SCIM Bridge reachability + bearer token validity (GET /Groups)
 *   2. Every declared group still exists, matched by displayName
 *
 * Membership drift is reported by driftDetect, not here - healthCheck only
 * confirms presence, mirroring every other name-keyed config type in this
 * codebase.
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildOnePasswordClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'onepassword_credential', passed: false, message: built.error }] }
  }
  const { client, baseUrl } = built

  let groups: LiveGroup[] = []
  const reachable = await timedCheck('onepassword_reachable', async () => {
    const res = await client.request('GET', '/Groups', { query: { count: 1 } })
    if (res.status === 401 || res.status === 403) {
      throw new Error('The SCIM Bridge rejected the bearer token')
    }
    if (!res.ok) throw new Error(scimErrorMessage(res))
    groups = await listGroups(client)
    return `1Password SCIM Bridge ${baseUrl} reachable`
  })
  checks.push(reachable)

  if (reachable.passed) {
    const specs = extractGroupSpecs(ctx.canvas).filter((s) => s.displayName)
    for (const spec of specs) {
      checks.push(
        await timedCheck(`group:${spec.displayName}`, async () => {
          const live = groups.find((g) => (g.displayName ?? '').toLowerCase() === spec.displayName.toLowerCase())
          if (!live) throw new Error(`Group "${spec.displayName}" does not exist on the bridge`)
          return `Group "${spec.displayName}" is present`
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
