import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildOpenctiUrl, buildAuthHeader, graphql } from '../../lib/openctiApi'
import { LIST_VOCABULARIES_QUERY, findVocabulary, normalizeOrder, normalizeText, toStringList, vocabulariesFromList } from './_shared'

/**
 * Drift for vocabularies: compare the description, order and aliases we declare
 * against the live entry in OpenCTI (matched by category + name). Best-effort —
 * an entry that can't be matched (missing / transient error) is skipped rather
 * than raising false drift. Read-only: vocabularies. Verified against the
 * OpenCTI GraphQL backend schema (opencti-platform/opencti,
 * src/modules/vocabulary/vocabulary.graphql).
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
    live = vocabulariesFromList(await graphql<unknown>(base, headers, LIST_VOCABULARIES_QUERY))
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read vocabularies, no drift asserted
  }

  for (const item of items) {
    const category = String(item.fields.category ?? '').trim()
    const name = String(item.fields.name ?? '').trim()
    if (!category || !name) continue
    const match = findVocabulary(live, category, name)
    if (!match) continue

    const label = `${category}/${name}`

    const expectedDescription = normalizeText(item.fields.description)
    const actualDescription = normalizeText(match.description)
    if (expectedDescription !== undefined && actualDescription !== undefined && expectedDescription !== actualDescription) {
      diffs.push({ field: `${label}.description`, expected: expectedDescription, actual: actualDescription, severity: 'info' })
    }

    const expectedOrder = normalizeOrder(item.fields.order)
    const actualOrder = normalizeOrder(match.order)
    if (expectedOrder !== undefined && actualOrder !== undefined && expectedOrder !== actualOrder) {
      diffs.push({ field: `${label}.order`, expected: expectedOrder, actual: actualOrder, severity: 'info' })
    }

    const expectedAliases = toStringList(item.fields.aliases)
    const actualAliases = toStringList(match.aliases)
    if (
      expectedAliases.length > 0 &&
      (expectedAliases.length !== actualAliases.length ||
        expectedAliases.some((a) => !actualAliases.some((b) => b.toLowerCase() === a.toLowerCase())))
    ) {
      diffs.push({ field: `${label}.aliases`, expected: expectedAliases, actual: actualAliases, severity: 'info' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
