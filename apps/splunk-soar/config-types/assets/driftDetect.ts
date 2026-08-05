import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildSoarUrl, buildAuthHeader, listAll } from '../../lib/soarApi'
import { canonicalJson, pickKeys } from '../../lib/soarCommon'
import { buildAssetSpec, findAssetByName, type SoarAsset } from './_shared'

/**
 * Drift for assets: compare every declared NON-SECRET field against the live
 * asset. `configuration` is never read back or compared — it is write-only
 * (see _shared.ts) and SOAR's GET response for it cannot be trusted to
 * distinguish ordinary settings from credential fields it may or may not mask.
 * Best-effort: an asset that can't be matched, or an unreadable /rest/asset
 * collection, reports no drift rather than a false positive. Read-only:
 * GET /rest/asset?page_size=0.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const base = buildSoarUrl(component, connectivity)
  const headers = buildAuthHeader(credential)

  let live: SoarAsset[]
  try {
    live = await listAll<SoarAsset>(base, headers, 'asset')
  } catch {
    return { hasDrift: false, diffs }
  }

  for (const item of items) {
    const spec = buildAssetSpec(item.fields)
    if (!spec.id || spec.error || !spec.nonSecretBody) continue

    const match = findAssetByName(live, spec.id)
    if (!match) {
      diffs.push({ field: spec.id, expected: 'present', actual: 'missing', severity: 'critical' })
      continue
    }

    const keys = Object.keys(spec.nonSecretBody)
    const expected = pickKeys(spec.nonSecretBody, keys)
    const actual = pickKeys(match, keys)
    if (canonicalJson(expected) !== canonicalJson(actual)) {
      diffs.push({ field: spec.id, expected, actual, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
