import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildOpenctiUrl, buildAuthHeader, graphql } from '../../lib/openctiApi'
import { LIST_FEEDS_QUERY, feedsFromList, findFeed, normalizeText } from './_shared'

/**
 * Drift for TAXII2 ingestion feeds: compare the URI, collection, version and auth
 * type we declare against the live feed in OpenCTI (matched by name). The secret
 * authentication_value is never read back, so it is not compared. Best-effort — a
 * feed that can't be matched (missing / transient error) is skipped rather than
 * raising false drift. Read-only: ingestionTaxiis. Verify against a live OpenCTI
 * instance.
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
    live = feedsFromList(await graphql<unknown>(base, headers, LIST_FEEDS_QUERY))
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read feeds, no drift asserted
  }

  for (const item of items) {
    const name = String(item.fields.name ?? '').trim()
    if (!name) continue
    const match = findFeed(live, name)
    if (!match) continue

    const compare: Array<[string, 'warning' | 'info']> = [
      ['uri', 'warning'],
      ['collection', 'warning'],
      ['version', 'info'],
      ['authentication_type', 'warning'],
    ]
    for (const [key, severity] of compare) {
      const expected = normalizeText(item.fields[key])
      const actual = normalizeText(match[key])
      if (expected !== undefined && actual !== undefined && expected !== actual) {
        diffs.push({ field: `${name}.${key}`, expected, actual, severity })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
