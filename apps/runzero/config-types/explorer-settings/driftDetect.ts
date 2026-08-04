import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildRunzeroUrl, buildAuthHeader, resolveRunzeroToken, getJson, coerceList } from '../../lib/runzeroApi'
import { resolveExplorerId, findExplorerById, resolveSiteId, text, type RunzeroExplorer, type RunzeroSiteLite } from './_shared'

/**
 * Drift for explorer settings: compare the declared Site assignment against the live Explorer in
 * runZero, matched by name/UUID. A declared Explorer that no longer exists (uninstalled) is
 * critical drift. Max Concurrent Scans is NEVER compared — runZero does not report the current
 * value back (see the WRITE-ONLY note in _shared.ts), so there is nothing to diff against.
 * Best-effort — if the explorer/site lists can't be read (transient error) no drift is asserted
 * rather than raising a false positive. Read-only: GET /org/explorers + GET /org/sites.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, deployedConfig, settings } = ctx
  const items = deployedConfig.items ?? deployedConfig.sections ?? []
  const diffs: DriftDiff[] = []

  if (!resolveRunzeroToken(credential)) return { hasDrift: false, diffs }

  const base = buildRunzeroUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)
  const rawTimeout = settings?.request_timeout_seconds
  const timeoutMs = typeof rawTimeout === 'number' && rawTimeout > 0 ? rawTimeout * 1000 : undefined

  let explorers: RunzeroExplorer[]
  let sites: RunzeroSiteLite[]
  try {
    explorers = coerceList<RunzeroExplorer>(await getJson<unknown>(`${base}/org/explorers`, headers, timeoutMs))
    sites = coerceList<RunzeroSiteLite>(await getJson<unknown>(`${base}/org/sites`, headers, timeoutMs))
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read explorers, no drift asserted
  }

  for (const item of items) {
    const explorerRef = text(item.fields.explorer)
    if (!explorerRef) continue

    const explorerId = resolveExplorerId(explorers, explorerRef)
    const match = findExplorerById(explorers, explorerId)
    if (!match) {
      diffs.push({ field: explorerRef, expected: 'exists', actual: 'missing (uninstalled or removed)', severity: 'critical' })
      continue
    }

    const declaredSite = text(item.fields.site)
    if (declaredSite) {
      const expectedSiteId = resolveSiteId(sites, declaredSite)
      const actualSiteId = text(match.site_id)
      if (expectedSiteId !== actualSiteId) {
        diffs.push({ field: `${explorerRef}.site`, expected: expectedSiteId, actual: actualSiteId, severity: 'warning' })
      }
    }
    // maxConcurrentScans intentionally never compared — write-only, see _shared.ts.
  }

  return { hasDrift: diffs.length > 0, diffs }
}
