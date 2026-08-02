import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildRunzeroUrl, buildAuthHeader, resolveRunzeroToken, getJson } from '../../lib/runzeroApi'
import { sitesFromList, findSite, scopeEquals, normalizeScope } from './_shared'

/**
 * Drift for sites: compare the description and default scan scope we declare
 * against the live site in runZero, matched by name. A declared site that is
 * missing entirely is critical drift. Best-effort — if the site list can't be
 * read (transient error / missing credential) no drift is asserted rather than
 * raising a false positive. Read-only: GET /org/sites.
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

  let live
  try {
    live = sitesFromList(await getJson<unknown>(`${base}/org/sites`, headers, timeoutMs))
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read sites, no drift asserted
  }

  for (const item of items) {
    const name = String(item.fields.name ?? '').trim()
    if (!name) continue

    const match = findSite(live, name)
    if (!match) {
      diffs.push({ field: name, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }

    const expectedDescription = String(item.fields.description ?? '').trim()
    const actualDescription = String(match.description ?? '').trim()
    if (expectedDescription !== actualDescription) {
      diffs.push({ field: `${name}.description`, expected: expectedDescription, actual: actualDescription, severity: 'info' })
    }

    if (!scopeEquals(item.fields.subnets, match.scope)) {
      diffs.push({
        field: `${name}.subnets`,
        expected: normalizeScope(item.fields.subnets),
        actual: normalizeScope(match.scope),
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
