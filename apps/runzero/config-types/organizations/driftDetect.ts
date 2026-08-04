import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildRunzeroUrl, buildAuthHeader, resolveRunzeroToken, getJson, coerceList } from '../../lib/runzeroApi'
import { findOrg, dayCount, parseExpirationSettings, deepEqualJson, text, type RunzeroOrganization } from './_shared'

/**
 * Drift for organizations: compare the description, parent, retention-day fields and advanced
 * expiration settings we declare against the live organization in runZero, matched by name. A
 * declared organization that is missing entirely is critical drift. Best-effort — if the org list
 * can't be read (transient error, or an Organization key without account scope) no drift is
 * asserted rather than raising a false positive. Read-only: GET /account/orgs.
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

  let live: RunzeroOrganization[]
  try {
    live = coerceList<RunzeroOrganization>(await getJson<unknown>(`${base}/account/orgs`, headers, timeoutMs))
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read orgs, no drift asserted
  }

  for (const item of items) {
    const name = text(item.fields.name)
    if (!name) continue

    const match = findOrg(live, name)
    if (!match) {
      diffs.push({ field: name, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }

    const expectedDescription = text(item.fields.description)
    const actualDescription = text(match.description)
    if (expectedDescription !== actualDescription) {
      diffs.push({ field: `${name}.description`, expected: expectedDescription, actual: actualDescription, severity: 'info' })
    }

    const expectedParent = text(item.fields.parentId)
    const actualParent = text(match.parent_id)
    if (expectedParent && expectedParent !== actualParent) {
      diffs.push({ field: `${name}.parentId`, expected: expectedParent, actual: actualParent, severity: 'warning' })
    }

    for (const [field, key, label] of [
      ['expirationAssetsStaleDays', 'expiration_assets_stale', 'expirationAssetsStaleDays'],
      ['expirationAssetsOfflineDays', 'expiration_assets_offline', 'expirationAssetsOfflineDays'],
      ['expirationScansDays', 'expiration_scans', 'expirationScansDays'],
    ] as const) {
      const declared = dayCount(item.fields[field])
      if (declared === undefined) continue // not declared — not drift-tracked
      const actual = match[key]
      if (Number(actual) !== declared) {
        diffs.push({ field: `${name}.${label}`, expected: String(declared), actual: String(actual ?? ''), severity: 'info' })
      }
    }

    const declaredSettings = parseExpirationSettings(item.fields.expirationSettingsJson)
    if (declaredSettings !== null) {
      const actualSettings = match.expiration_settings ?? {}
      if (!deepEqualJson(declaredSettings, actualSettings)) {
        diffs.push({
          field: `${name}.expirationSettingsJson`,
          expected: JSON.stringify(declaredSettings),
          actual: JSON.stringify(actualSettings),
          severity: 'warning',
        })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
