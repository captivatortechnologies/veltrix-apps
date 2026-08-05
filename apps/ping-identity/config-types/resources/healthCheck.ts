import type { HealthCheck, HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildPingOneClient } from '../../lib/pingOne'
import { listResources, listScopes } from './deploy'
import { extractResourceSpecs, findResourceByName, isCustomResource, parseScopesJson, scopeKey } from './_shared'

/**
 * Health check for Resources + Scopes configuration:
 *   1. PingOne environment reachability + credential validity (a resource
 *      list read)
 *   2. Every declared resource (by name) exists - a built-in/protected match
 *      is reported as passed with an informational message, never a failure
 *   3. Every declared scope within an existing CUSTOM resource (by name)
 *      exists
 * Score is the fraction of passed checks (0-1).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheck[] = []

  const built = buildPingOneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'pingone_credential', passed: false, message: built.error }] }
  }
  const { client, environmentId } = built

  const started = Date.now()
  let liveResources: Awaited<ReturnType<typeof listResources>> | null = null
  try {
    liveResources = await listResources(client)
    checks.push({
      name: 'pingone_reachable',
      passed: true,
      message: `PingOne environment ${environmentId} reachable`,
      latencyMs: Date.now() - started,
    })
  } catch (error) {
    checks.push({
      name: 'pingone_reachable',
      passed: false,
      message: error instanceof Error ? error.message : 'Could not reach PingOne',
      latencyMs: Date.now() - started,
    })
  }

  if (liveResources) {
    const specs = extractResourceSpecs(ctx.canvas).filter((s) => s.name)
    for (const spec of specs) {
      const label = spec.name
      const found = findResourceByName(liveResources, spec.name)
      const custom = isCustomResource(found)
      checks.push({
        name: `resource:${label}`,
        passed: !!found,
        message: !found
          ? `Resource "${label}" is missing`
          : custom
            ? `Resource "${label}" is present`
            : `Resource "${label}" is present (built-in/protected, type ${found.type ?? 'unknown'} - not managed by this app)`,
      })
      if (!found || !found.id || !custom) continue

      const declaredScopes = parseScopesJson(spec.scopesRaw)
      if (!declaredScopes.ok || !declaredScopes.value?.length) continue

      let liveScopeKeys: Set<string>
      try {
        const liveScopes = await listScopes(client, found.id)
        liveScopeKeys = new Set(liveScopes.filter((s) => s.name).map((s) => scopeKey(s.name as string)))
      } catch {
        continue
      }
      for (const raw of declaredScopes.value) {
        const name = typeof raw === 'object' && raw !== null && 'name' in raw ? String((raw as { name?: unknown }).name ?? '') : ''
        if (!name) continue
        const present = liveScopeKeys.has(scopeKey(name))
        checks.push({
          name: `scope:${label}/${name}`,
          passed: present,
          message: present ? `Scope "${name}" is present` : `Scope "${name}" is missing`,
        })
      }
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  return { healthy: passedCount === checks.length, score: checks.length ? passedCount / checks.length : 0, checks }
}
