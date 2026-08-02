import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildGraylogUrl, buildAuthHeader, getJson } from '../../lib/graylogApi'
import { asString } from '../../lib/coerce'
import { rulesFromList, findRule, normalizeSource } from './_shared'

/**
 * Drift for pipeline rules: compare the (whitespace-normalized) DSL source and the
 * description we declare against the live rule in Graylog. Source is normalized so
 * cosmetic reformatting is not read as drift. Best-effort, read-only:
 * GET /api/system/pipelines/rule.
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
    live = rulesFromList(await getJson<unknown>(`${base}/api/system/pipelines/rule`, headers))
  } catch {
    return { hasDrift: false, diffs }
  }

  for (const item of items) {
    const title = asString(item.fields.title)
    const match = findRule(live, title)
    if (!match) continue

    const expectedSource = normalizeSource(item.fields.source)
    const actualSource = normalizeSource(match.source)
    if (expectedSource !== actualSource) {
      diffs.push({ field: `${title}.source`, expected: expectedSource, actual: actualSource, severity: 'warning' })
    }

    const expectedDescription = asString(item.fields.description)
    const actualDescription = asString(match.description)
    if (expectedDescription !== actualDescription) {
      diffs.push({ field: `${title}.description`, expected: expectedDescription, actual: actualDescription, severity: 'info' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
