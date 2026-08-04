import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildMispUrl, buildAuthHeader, getJson } from '../../lib/mispApi'
import { galaxiesFromList, findGalaxy, normalizeYesNo } from './_shared'

/**
 * Drift for galaxies: compare the declared enabled/local_only state and
 * description against the live custom galaxy in MISP. Best-effort — a galaxy
 * that can't be matched (missing / transient error) is skipped rather than
 * raising false drift; MISP's own default galaxies are never matched. Read-only:
 * GET /galaxies. Verify against a live MISP 2.4 instance.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const base = buildMispUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let live
  try {
    live = galaxiesFromList(await getJson<unknown>(`${base}/galaxies`, headers))
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read galaxies, no drift asserted
  }

  for (const item of items) {
    const type = String(item.fields.type ?? '').trim()
    const match = findGalaxy(live, type)
    if (!match) continue

    const expectedEnabled = normalizeYesNo(item.fields.enabled)
    const actualEnabled = normalizeYesNo(match.enabled)
    if (actualEnabled !== expectedEnabled) {
      diffs.push({ field: `${type}.enabled`, expected: expectedEnabled, actual: actualEnabled, severity: 'warning' })
    }

    const expectedLocalOnly = normalizeYesNo(item.fields.local_only)
    const actualLocalOnly = normalizeYesNo(match.local_only)
    if (actualLocalOnly !== expectedLocalOnly) {
      diffs.push({ field: `${type}.local_only`, expected: expectedLocalOnly, actual: actualLocalOnly, severity: 'warning' })
    }

    const expectedDescription = String(item.fields.description ?? '').trim()
    const actualDescription = String(match.description ?? '').trim()
    if (expectedDescription && actualDescription !== expectedDescription) {
      diffs.push({ field: `${type}.description`, expected: expectedDescription, actual: actualDescription, severity: 'info' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
