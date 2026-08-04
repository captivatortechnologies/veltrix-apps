import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildGraylogUrl, buildAuthHeader, getJson } from '../../lib/graylogApi'
import { asString, toInt } from '../../lib/coerce'
import { extractorsFromList, findExtractor, inputsFromList, findInput } from './_shared'

/**
 * Drift for extractors: compare the type, cursor strategy, source/target field
 * and order we declare against the live extractor in Graylog (matched within
 * its input by title). Best-effort — an input or extractor that can't be
 * matched is skipped rather than raising false drift. Read-only:
 * GET /api/system/inputs, GET /api/system/inputs/{inputId}/extractors.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const base = buildGraylogUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let liveInputs
  try {
    liveInputs = inputsFromList(await getJson<unknown>(`${base}/api/system/inputs`, headers))
  } catch {
    return { hasDrift: false, diffs }
  }

  const extractorListCache = new Map<string, ReturnType<typeof extractorsFromList>>()

  for (const item of items) {
    const inputTitle = asString(item.fields.input_title)
    const title = asString(item.fields.title)
    if (!inputTitle || !title) continue

    const input = findInput(liveInputs, inputTitle)
    if (!input?.id) continue

    let liveExtractors = extractorListCache.get(input.id)
    if (!liveExtractors) {
      try {
        liveExtractors = extractorsFromList(await getJson<unknown>(`${base}/api/system/inputs/${encodeURIComponent(input.id)}/extractors`, headers))
      } catch {
        liveExtractors = []
      }
      extractorListCache.set(input.id, liveExtractors)
    }

    const match = findExtractor(liveExtractors, title)
    if (!match) continue

    const label = `${inputTitle}/${title}`
    const expectedType = asString(item.fields.extractor_type).toUpperCase()
    const actualType = asString(match.type).toUpperCase()
    if (expectedType !== actualType) {
      diffs.push({ field: `${label}.extractor_type`, expected: expectedType, actual: actualType, severity: 'warning' })
    }

    const expectedTarget = asString(item.fields.target_field)
    const actualTarget = asString(match.target_field)
    if (expectedTarget !== actualTarget) {
      diffs.push({ field: `${label}.target_field`, expected: expectedTarget, actual: actualTarget, severity: 'warning' })
    }

    const expectedOrder = toInt(item.fields.order, 0)
    const actualOrder = typeof match.order === 'number' ? match.order : 0
    if (expectedOrder !== actualOrder) {
      diffs.push({ field: `${label}.order`, expected: String(expectedOrder), actual: String(actualOrder), severity: 'info' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
