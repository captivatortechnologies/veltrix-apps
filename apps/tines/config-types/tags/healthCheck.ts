import type { HealthCheckContext, HealthCheckResult, HealthCheck } from '@veltrixsecops/app-sdk'
import { buildTinesClient, tinesErrorMessage } from '../../lib/tinesApi'
import { extractTagSpecs, findTag } from './_shared'
import { listTags } from './deploy'

/**
 * Health check for tags configuration:
 *   1. Tines API reachability + auth (GET /api/v1/tags answers 2xx)
 *   2. every declared tag (by team + name) still exists in the tenant
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheck[] = []

  const built = buildTinesClient(ctx.component?.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'credential', passed: false, message: built.error }] }
  }
  const { client } = built

  const started = Date.now()
  let reachable = false
  try {
    const res = await client.request('GET', '/tags', { query: { per_page: 1 } })
    reachable = res.ok
    checks.push({
      name: 'tines_reachable',
      passed: res.ok,
      message: res.ok ? `Tines reachable (HTTP ${res.status}).` : `Tines returned HTTP ${res.status}: ${tinesErrorMessage(res)}`,
      latencyMs: Date.now() - started,
    })
  } catch (error) {
    checks.push({
      name: 'tines_reachable',
      passed: false,
      message: `Tines unreachable: ${error instanceof Error ? error.message : 'error'}`,
      latencyMs: Date.now() - started,
    })
  }

  if (reachable) {
    const specs = extractTagSpecs(ctx.canvas).filter((s) => s.name && s.teamId)
    const cache = new Map<string, Awaited<ReturnType<typeof listTags>>>()
    for (const spec of specs) {
      try {
        let live = cache.get(spec.teamId)
        if (!live) {
          live = await listTags(client, spec.teamId)
          cache.set(spec.teamId, live)
        }
        const present = Boolean(findTag(live, spec.teamId, spec.name))
        checks.push({
          name: `tag:${spec.name}`,
          passed: present,
          message: present ? `Tag "${spec.name}" is present.` : `Tag "${spec.name}" is missing.`,
        })
      } catch (error) {
        checks.push({
          name: `tag:${spec.name}`,
          passed: false,
          message: `Could not list tags: ${error instanceof Error ? error.message : 'error'}`,
        })
      }
    }
  }

  const passed = checks.filter((c) => c.passed).length
  return { healthy: passed === checks.length, score: checks.length ? passed / checks.length : 0, checks }
}
