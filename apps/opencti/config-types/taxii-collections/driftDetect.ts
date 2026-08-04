import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildOpenctiUrl, buildAuthHeader, graphql } from '../../lib/openctiApi'
import { LIST_TAXII_COLLECTIONS_QUERY, findTaxiiCollection, taxiiCollectionsFromList, normalizeBool, normalizeText } from './_shared'

/**
 * Drift for taxii-collections: compare description, taxii_public,
 * include_inferences and score_to_confidence against the live collection in
 * OpenCTI (matched by name). `filters` is intentionally NOT compared —
 * OpenCTI may reformat/reorder the stored JSON, which would raise false drift
 * for a semantically unchanged filter. Best-effort — a collection that can't
 * be matched (missing / transient error) is skipped rather than raising false
 * drift. Read-only: taxiiCollections.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const base = buildOpenctiUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let live
  try {
    live = taxiiCollectionsFromList(await graphql<unknown>(base, headers, LIST_TAXII_COLLECTIONS_QUERY))
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read TAXII collections, no drift asserted
  }

  for (const item of items) {
    const name = String(item.fields.name ?? '').trim()
    if (!name) continue
    const match = findTaxiiCollection(live, name)
    if (!match) continue

    const expectedDescription = normalizeText(item.fields.description)
    const actualDescription = normalizeText(match.description)
    if (expectedDescription !== undefined && actualDescription !== undefined && expectedDescription !== actualDescription) {
      diffs.push({ field: `${name}.description`, expected: expectedDescription, actual: actualDescription, severity: 'info' })
    }

    const expectedPublic = normalizeBool(item.fields.taxii_public)
    const actualPublic = normalizeBool(match.taxii_public)
    if (expectedPublic !== undefined && actualPublic !== undefined && expectedPublic !== actualPublic) {
      diffs.push({ field: `${name}.taxii_public`, expected: expectedPublic, actual: actualPublic, severity: 'warning' })
    }

    const expectedInferences = normalizeBool(item.fields.include_inferences)
    const actualInferences = normalizeBool(match.include_inferences)
    if (expectedInferences !== undefined && actualInferences !== undefined && expectedInferences !== actualInferences) {
      diffs.push({ field: `${name}.include_inferences`, expected: expectedInferences, actual: actualInferences, severity: 'info' })
    }

    const expectedScoreToConfidence = normalizeBool(item.fields.score_to_confidence)
    const actualScoreToConfidence = normalizeBool(match.score_to_confidence)
    if (
      expectedScoreToConfidence !== undefined &&
      actualScoreToConfidence !== undefined &&
      expectedScoreToConfidence !== actualScoreToConfidence
    ) {
      diffs.push({
        field: `${name}.score_to_confidence`,
        expected: expectedScoreToConfidence,
        actual: actualScoreToConfidence,
        severity: 'info',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
