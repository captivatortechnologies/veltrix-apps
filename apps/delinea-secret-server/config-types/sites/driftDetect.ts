import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildSecretServerClient, normalizeBool } from '../../lib/secretServerApi'
import { extractSiteSpecs, searchSites, findSiteByName } from './_shared'

/**
 * Drift for sites: for each declared site, re-find it by name and compare the
 * managed fields. A site that can't be found is critical drift. Best-effort —
 * a read error asserts no drift rather than raising a false critical.
 * Read-only: GET /api/v1/distributed-engine/sites.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildSecretServerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const items = ctx.deployedConfig.items ?? ctx.deployedConfig.sections ?? []
  const specs = extractSiteSpecs(items).filter((s) => s.siteName)
  if (specs.length === 0) return { hasDrift: false, diffs }

  try {
    for (const spec of specs) {
      const matches = await searchSites(client, spec.siteName)
      const match = findSiteByName(matches, spec.siteName)
      if (!match) {
        diffs.push({ field: spec.siteName, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      const checks: Array<[string, unknown, unknown]> = [
        ['active', spec.active, match.active !== undefined ? normalizeBool(match.active) : undefined],
        ['siteConnectorId', spec.siteConnectorId, match.siteConnectorId],
        ['callbackInterval', spec.callbackInterval, match.heartbeatInterval],
        ['winRmEndpoint', spec.winRmEndpoint, match.winRmEndPointUrl],
        ['enableCredSsp', spec.enableCredSsp, match.enableCredSspForWinRm !== undefined ? normalizeBool(match.enableCredSspForWinRm) : undefined],
        ['enableRdpProxy', spec.enableRdpProxy, match.enableRdpProxy !== undefined ? normalizeBool(match.enableRdpProxy) : undefined],
        ['enableSshProxy', spec.enableSshProxy, match.enableSshProxy !== undefined ? normalizeBool(match.enableSshProxy) : undefined],
      ]
      for (const [field, expected, actual] of checks) {
        if (actual !== undefined && expected !== actual) {
          diffs.push({ field: `${spec.siteName}.${field}`, expected, actual, severity: 'warning' })
        }
      }
    }
  } catch {
    return { hasDrift: false, diffs } // best-effort: unreadable → no drift asserted
  }

  return { hasDrift: diffs.length > 0, diffs }
}
