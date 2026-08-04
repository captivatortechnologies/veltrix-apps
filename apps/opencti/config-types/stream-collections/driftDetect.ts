import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildOpenctiUrl, buildAuthHeader, graphql } from '../../lib/openctiApi'
import { LIST_STREAM_COLLECTIONS_QUERY, findStreamCollection, streamCollectionsFromList, normalizeBool, normalizeText } from './_shared'

/**
 * Drift for stream-collections: compare description, stream_live and
 * stream_public against the live collection in OpenCTI (matched by name).
 * `filters` and `origin_filters` are intentionally NOT compared — OpenCTI may
 * reformat/reorder the stored JSON, which would raise false drift for a
 * semantically unchanged filter. Best-effort — a collection that can't be
 * matched (missing / transient error) is skipped rather than raising false
 * drift. Read-only: streamCollections.
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
    live = streamCollectionsFromList(await graphql<unknown>(base, headers, LIST_STREAM_COLLECTIONS_QUERY))
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read stream collections, no drift asserted
  }

  for (const item of items) {
    const name = String(item.fields.name ?? '').trim()
    if (!name) continue
    const match = findStreamCollection(live, name)
    if (!match) continue

    const expectedDescription = normalizeText(item.fields.description)
    const actualDescription = normalizeText(match.description)
    if (expectedDescription !== undefined && actualDescription !== undefined && expectedDescription !== actualDescription) {
      diffs.push({ field: `${name}.description`, expected: expectedDescription, actual: actualDescription, severity: 'info' })
    }

    const expectedLive = normalizeBool(item.fields.stream_live)
    const actualLive = normalizeBool(match.stream_live)
    if (expectedLive !== undefined && actualLive !== undefined && expectedLive !== actualLive) {
      diffs.push({ field: `${name}.stream_live`, expected: expectedLive, actual: actualLive, severity: 'warning' })
    }

    const expectedPublic = normalizeBool(item.fields.stream_public)
    const actualPublic = normalizeBool(match.stream_public)
    if (expectedPublic !== undefined && actualPublic !== undefined && expectedPublic !== actualPublic) {
      diffs.push({ field: `${name}.stream_public`, expected: expectedPublic, actual: actualPublic, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
