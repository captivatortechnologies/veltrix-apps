import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildSonarqubeUrl, buildAuthHeader, getJson } from '../../lib/sonarqubeApi'
import { ALM_TYPES, definitionsFromListResponse } from './_shared'

/**
 * Drift for ALM settings: compare presence, ALM type and (for providers that use one) URL
 * against the live definition in SonarQube. An ALM-type mismatch is reported as 'critical'
 * severity — this app has no in-place type-change API and cannot self-heal it (see the
 * matching guard in deploy.ts). Read-only:
 *   GET /api/alm_settings/list_definitions
 * Best-effort: a read failure reports no drift rather than a false positive.
 *
 * NOTE: unlike webhooks (which exposes a `hasSecret` flag), list_definitions returns NO
 * secret-presence signal at all, for any of the 5 providers. So secret drift CANNOT be
 * detected here — not even as presence/absence, only as "unknowable."
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const base = buildSonarqubeUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let live: ReturnType<typeof definitionsFromListResponse>
  try {
    live = definitionsFromListResponse(await getJson<unknown>(`${base}/api/alm_settings/list_definitions`, headers))
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read settings, no drift asserted
  }

  for (const item of items) {
    const key = String(item.fields.key ?? '').trim()
    const almType = String(item.fields.almType ?? '').trim()
    if (!key || !almType || !ALM_TYPES.has(almType)) continue

    const match = live.get(key)
    if (!match) {
      diffs.push({ field: key, expected: 'present', actual: 'missing', severity: 'warning' })
      continue
    }

    if (match.almType !== almType) {
      diffs.push({ field: `${key}.almType`, expected: almType, actual: match.almType, severity: 'critical' })
      continue
    }

    // bitbucketcloud has no url — nothing further to compare besides identity/type above,
    // since clientId/workspace are non-secret but this app does not currently declare
    // drift on them (mirrors webhooks: only presence + the field the operator most commonly
    // changes, the delivery/API url, is compared).
    if (almType === 'bitbucketcloud') continue

    const url = String(item.fields.url ?? '').trim()
    if (url && String(match.url ?? '') !== url) {
      diffs.push({ field: `${key}.url`, expected: url, actual: String(match.url ?? ''), severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
