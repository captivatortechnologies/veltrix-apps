import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildGraylogUrl, buildAuthHeader, getJson } from '../../lib/graylogApi'
import { streamsFromList, findStream, normalizeMatchingType, toBool, parseRules } from './_shared'

/**
 * Drift for streams: compare the matching type, description, default-stream removal
 * and rule count we declare against the live stream in Graylog. Best-effort — a
 * stream that can't be matched (missing / transient error) is skipped rather than
 * raising false drift. Read-only: GET /api/streams. Verify against a live Graylog.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const base = buildGraylogUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let live
  try {
    live = streamsFromList(await getJson<unknown>(`${base}/api/streams`, headers))
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read streams, no drift asserted
  }

  for (const item of items) {
    const title = String(item.fields.title ?? '').trim()
    const match = findStream(live, title)
    if (!match) continue

    const expectedMatching = normalizeMatchingType(item.fields.matching_type)
    const actualMatching = normalizeMatchingType(match.matching_type)
    if (expectedMatching !== actualMatching) {
      diffs.push({ field: `${title}.matching_type`, expected: expectedMatching, actual: actualMatching, severity: 'warning' })
    }

    const expectedDescription = String(item.fields.description ?? '').trim()
    const actualDescription = String(match.description ?? '').trim()
    if (expectedDescription !== actualDescription) {
      diffs.push({ field: `${title}.description`, expected: expectedDescription, actual: actualDescription, severity: 'info' })
    }

    const expectedRemove = toBool(item.fields.remove_matches_from_default_stream)
    const actualRemove = toBool(match.remove_matches_from_default_stream)
    if (expectedRemove !== actualRemove) {
      diffs.push({ field: `${title}.remove_matches_from_default_stream`, expected: expectedRemove, actual: actualRemove, severity: 'warning' })
    }

    const expectedRuleCount = parseRules(item.fields.rules).rules.length
    const actualRuleCount = Array.isArray(match.rules) ? match.rules.length : 0
    if (expectedRuleCount !== actualRuleCount) {
      diffs.push({ field: `${title}.rules.count`, expected: expectedRuleCount, actual: actualRuleCount, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
