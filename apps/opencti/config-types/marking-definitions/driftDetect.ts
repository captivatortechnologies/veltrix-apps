import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildOpenctiUrl, buildAuthHeader, graphql } from '../../lib/openctiApi'
import { LIST_MARKINGS_QUERY, findMarking, markingsFromList, normalizeColor, normalizeOrder } from './_shared'

/**
 * Drift for marking definitions: compare the type, color and order we declare
 * against the live marking in OpenCTI (matched by definition value). Best-effort —
 * a marking that can't be matched (missing / transient error) is skipped rather
 * than raising false drift. Read-only: markingDefinitions. Verify against a live
 * OpenCTI instance.
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
    live = markingsFromList(await graphql<unknown>(base, headers, LIST_MARKINGS_QUERY))
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read markings, no drift asserted
  }

  for (const item of items) {
    const definition = String(item.fields.definition ?? '').trim()
    if (!definition) continue
    const match = findMarking(live, definition)
    if (!match) continue

    const expectedType = String(item.fields.definition_type ?? '').trim()
    const actualType = String(match.definition_type ?? '').trim()
    if (expectedType && actualType && expectedType !== actualType) {
      diffs.push({ field: `${definition}.definition_type`, expected: expectedType, actual: actualType, severity: 'warning' })
    }

    const expectedColor = normalizeColor(item.fields.x_opencti_color)
    const actualColor = normalizeColor(match.x_opencti_color)
    if (expectedColor !== undefined && actualColor !== undefined && expectedColor.toLowerCase() !== actualColor.toLowerCase()) {
      diffs.push({ field: `${definition}.x_opencti_color`, expected: expectedColor, actual: actualColor, severity: 'info' })
    }

    const expectedOrder = normalizeOrder(item.fields.x_opencti_order)
    const actualOrder = normalizeOrder(match.x_opencti_order)
    if (expectedOrder !== undefined && actualOrder !== undefined && expectedOrder !== actualOrder) {
      diffs.push({ field: `${definition}.x_opencti_order`, expected: expectedOrder, actual: actualOrder, severity: 'info' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
