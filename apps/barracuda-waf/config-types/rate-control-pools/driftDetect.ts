import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildBarracudaClient } from '../../lib/barracudaWaf'
import { extractRateControlPoolSpecs, listRateControlPools, rateControlPoolKey, type LiveRateControlPool } from './validate'

/**
 * Detect drift between the deployed Rate Control Pools and the live
 * Application: a declared pool missing live is critical; a live pool not
 * declared (this config type owns the full list) is drift; the scalar
 * request-rate limits are diffed field-by-field. `preferred_clients`/`urls`
 * are only diffed on array LENGTH — a coarse signal that the embedded JSON
 * list changed, without deep structural comparison of each nested entry.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildBarracudaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client, appName } = built

  const specs = extractRateControlPoolSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listRateControlPools(client, appName)
    const byKey = new Map<string, LiveRateControlPool>(live.filter((p) => p.name).map((p) => [rateControlPoolKey(p.name as string), p]))
    const declaredKeys = new Set(specs.map((s) => rateControlPoolKey(s.name)))

    for (const spec of specs) {
      const found = byKey.get(rateControlPoolKey(spec.name))
      if (!found) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }
      if ((found.max_active_requests ?? 100) !== spec.maxActiveRequests) {
        diffs.push({ field: `${spec.name}.max_active_requests`, expected: spec.maxActiveRequests, actual: found.max_active_requests ?? 100, severity: 'warning' })
      }
      if ((found.max_unconfigured_clients ?? 100) !== spec.maxUnconfiguredClients) {
        diffs.push({ field: `${spec.name}.max_unconfigured_clients`, expected: spec.maxUnconfiguredClients, actual: found.max_unconfigured_clients ?? 100, severity: 'warning' })
      }
      if ((found.max_per_client_backlog ?? 32) !== spec.maxPerClientBacklog) {
        diffs.push({ field: `${spec.name}.max_per_client_backlog`, expected: spec.maxPerClientBacklog, actual: found.max_per_client_backlog ?? 32, severity: 'warning' })
      }

      const foundPreferredCount = (found.preferred_clients ?? []).length
      if (foundPreferredCount !== spec.preferredClients.length) {
        diffs.push({
          field: `${spec.name}.preferred_clients`,
          expected: `${spec.preferredClients.length} entries`,
          actual: `${foundPreferredCount} entries`,
          severity: 'warning',
        })
      }
      const foundUrlsCount = (found.urls ?? []).length
      if (foundUrlsCount !== spec.urls.length) {
        diffs.push({ field: `${spec.name}.urls`, expected: `${spec.urls.length} entries`, actual: `${foundUrlsCount} entries`, severity: 'warning' })
      }
    }

    for (const pool of live) {
      if (pool.name && !declaredKeys.has(rateControlPoolKey(pool.name))) {
        diffs.push({ field: pool.name, expected: 'not present (undeclared)', actual: 'present', severity: 'warning' })
      }
    }
  } catch (error) {
    diffs.push({
      field: 'barracuda-waf',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
