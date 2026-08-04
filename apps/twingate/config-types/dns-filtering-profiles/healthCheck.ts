import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildTwingateClient } from '../../lib/twingateApi'
import { listProfiles } from './deploy'
import { extractDnsFilteringProfileSpecs, profileKey, type LiveDnsFilteringProfile } from './_shared'

/**
 * Health check for DNS Filtering Profile configuration:
 *   1. Twingate GraphQL reachability + API key validity (a profile list)
 *   2. Every declared profile (by name) still exists
 * Score is the percentage of passed checks (0-100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildTwingateClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'twingate_credential', passed: false, message: built.error }] }
  }
  const { client, graphqlUrl } = built

  const specs = extractDnsFilteringProfileSpecs(ctx.canvas).filter((s) => s.name)

  const reachable = await timedCheck('twingate_reachable', async () => {
    const live = await listProfiles(client)
    return { message: `Twingate reachable at ${graphqlUrl}`, live }
  })
  checks.push({ name: reachable.name, passed: reachable.passed, message: reachable.message, latencyMs: reachable.latencyMs })

  if (reachable.passed && reachable.live) {
    const names = new Set(reachable.live.filter((p) => p.name).map((p) => profileKey(p.name as string)))
    for (const spec of specs) {
      const present = names.has(profileKey(spec.name))
      checks.push({
        name: `dns-filtering-profile:${spec.name}`,
        passed: present,
        message: present ? `DNS Filtering Profile "${spec.name}" is present` : `DNS Filtering Profile "${spec.name}" is missing`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length === 0 ? 0 : Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}

async function timedCheck(
  name: string,
  fn: () => Promise<{ message: string; live?: LiveDnsFilteringProfile[] }>,
): Promise<{ name: string; passed: boolean; message: string; latencyMs: number; live?: LiveDnsFilteringProfile[] }> {
  const start = Date.now()
  try {
    const { message, live } = await fn()
    return { name, passed: true, message, latencyMs: Date.now() - start, live }
  } catch (error) {
    return { name, passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start }
  }
}
