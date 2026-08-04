import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildMispUrl, buildAuthHeader, getJson } from '../../lib/mispApi'
import { tagsFromList, findTag, normalizeYesNo, normalizeNumber } from './_shared'

/**
 * Drift for tags: compare the declared colour (when set), exportable, local_only,
 * hide_tag, numerical_value and org_id against the live tag in MISP. Best-effort —
 * a tag that can't be matched (missing / transient error) is skipped rather than
 * raising false drift. Colour is only compared when explicitly declared — a blank
 * canvas colour intentionally defers to whatever MISP has. Read-only:
 * GET /tags/index. Verify against a live MISP 2.4 instance.
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
    live = tagsFromList(await getJson<unknown>(`${base}/tags/index`, headers))
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read tags, no drift asserted
  }

  for (const item of items) {
    const name = String(item.fields.name ?? '').trim()
    const match = findTag(live, name)
    if (!match) continue

    const colour = String(item.fields.colour ?? '').trim()
    if (colour) {
      const liveColour = String(match.colour ?? '').trim()
      if (liveColour.toLowerCase() !== colour.toLowerCase()) {
        diffs.push({ field: `${name}.colour`, expected: colour, actual: liveColour, severity: 'info' })
      }
    }

    const expectedExportable = normalizeYesNo(item.fields.exportable)
    const actualExportable = normalizeYesNo(match.exportable)
    if (actualExportable !== expectedExportable) {
      diffs.push({ field: `${name}.exportable`, expected: expectedExportable, actual: actualExportable, severity: 'warning' })
    }

    const expectedLocalOnly = normalizeYesNo(item.fields.local_only)
    const actualLocalOnly = normalizeYesNo(match.local_only)
    if (actualLocalOnly !== expectedLocalOnly) {
      diffs.push({ field: `${name}.local_only`, expected: expectedLocalOnly, actual: actualLocalOnly, severity: 'warning' })
    }

    const expectedHideTag = normalizeYesNo(item.fields.hide_tag)
    const actualHideTag = normalizeYesNo(match.hide_tag)
    if (actualHideTag !== expectedHideTag) {
      diffs.push({ field: `${name}.hide_tag`, expected: expectedHideTag, actual: actualHideTag, severity: 'info' })
    }

    const expectedNumericalValue = normalizeNumber(item.fields.numerical_value)
    const actualNumericalValue = normalizeNumber(match.numerical_value)
    if (expectedNumericalValue !== undefined && expectedNumericalValue !== actualNumericalValue) {
      diffs.push({ field: `${name}.numerical_value`, expected: expectedNumericalValue, actual: actualNumericalValue ?? null, severity: 'info' })
    }

    const expectedOrgId = normalizeNumber(item.fields.org_id) ?? 0
    const actualOrgId = normalizeNumber(match.org_id) ?? 0
    if (expectedOrgId !== actualOrgId) {
      diffs.push({ field: `${name}.org_id`, expected: expectedOrgId, actual: actualOrgId, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
