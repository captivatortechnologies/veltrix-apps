import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildOpenctiUrl, buildAuthHeader, graphql } from '../../lib/openctiApi'
import { LIST_FEEDS_QUERY, feedsFromList, findFeed, normalizeBool, toStringList } from './_shared'

/**
 * Drift for feeds: compare the simple scalar/list fields we declare
 * (separator, feed_date_attribute, rolling_time, include_header, feed_types,
 * feed_public) against the live feed in OpenCTI (matched by name).
 * `filters`/`feed_attributes` are declared but intentionally not diffed — both
 * are free-form JSON OpenCTI may reformat, the same precedent used by every
 * other JSON-blob field in this app. Best-effort — a feed that can't be
 * matched (missing / transient error) is skipped rather than raising false
 * drift. Read-only: feeds.
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

    const scalarChecks: Array<[string, string | undefined, string | undefined]> = [
      ['separator', String(item.fields.separator ?? '').trim(), match.separator != null ? String(match.separator) : undefined],
      ['feed_date_attribute', String(item.fields.feed_date_attribute ?? '').trim(), match.feed_date_attribute != null ? String(match.feed_date_attribute) : undefined],
    ]
    for (const [field, expected, actual] of scalarChecks) {
      if (expected && actual !== undefined && expected !== actual) {
        diffs.push({ field: `${name}.${field}`, expected, actual, severity: 'warning' })
      }
    }

    const expectedRolling = Number(item.fields.rolling_time)
    if (Number.isFinite(expectedRolling) && typeof match.rolling_time === 'number' && expectedRolling !== match.rolling_time) {
      diffs.push({ field: `${name}.rolling_time`, expected: expectedRolling, actual: match.rolling_time, severity: 'info' })
    }

    const expectedIncludeHeader = normalizeBool(item.fields.include_header, true)
    if (typeof match.include_header === 'boolean' && expectedIncludeHeader !== match.include_header) {
      diffs.push({ field: `${name}.include_header`, expected: expectedIncludeHeader, actual: match.include_header, severity: 'info' })
    }

    const expectedPublic = normalizeBool(item.fields.feed_public, false)
    if (typeof match.feed_public === 'boolean' && expectedPublic !== match.feed_public) {
      diffs.push({ field: `${name}.feed_public`, expected: expectedPublic, actual: match.feed_public, severity: 'warning' })
    }

    const expectedTypes = toStringList(item.fields.feed_types).slice().sort()
    const actualTypes = (Array.isArray(match.feed_types) ? match.feed_types : []).slice().sort()
    if (JSON.stringify(expectedTypes) !== JSON.stringify(actualTypes)) {
      diffs.push({ field: `${name}.feed_types`, expected: expectedTypes.join(', '), actual: actualTypes.join(', '), severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
