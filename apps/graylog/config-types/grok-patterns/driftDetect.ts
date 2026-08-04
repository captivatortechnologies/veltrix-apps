import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildGraylogUrl, buildAuthHeader, getJson } from '../../lib/graylogApi'
import { asString } from '../../lib/coerce'
import { grokPatternsFromList, findGrokPattern } from './_shared'

/**
 * Drift for grok patterns: compare the declared pattern definition against the
 * live pattern in Graylog. Best-effort — a pattern that can't be matched is
 * skipped rather than raising false drift. Read-only: GET /api/system/grok.
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
    live = grokPatternsFromList(await getJson<unknown>(`${base}/api/system/grok`, headers))
  } catch {
    return { hasDrift: false, diffs }
  }

  for (const item of items) {
    const name = asString(item.fields.name)
    const match = findGrokPattern(live, name)
    if (!match) continue

    const expectedPattern = String(item.fields.pattern ?? '').trim()
    const actualPattern = String(match.pattern ?? '').trim()
    if (expectedPattern !== actualPattern) {
      diffs.push({ field: `${name}.pattern`, expected: expectedPattern, actual: actualPattern, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
