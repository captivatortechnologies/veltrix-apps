import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildOpenctiUrl, buildAuthHeader, graphql } from '../../lib/openctiApi'
import { LIST_LABELS_QUERY, findLabel, labelsFromList, normalizeColor } from './_shared'

/**
 * Drift for labels: compare the color we declare against the live label in OpenCTI
 * (matched by value). Best-effort — a label that can't be matched (missing /
 * transient error) is skipped rather than raising false drift. Read-only: labels.
 * Verify against a live OpenCTI instance.
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
    live = labelsFromList(await graphql<unknown>(base, headers, LIST_LABELS_QUERY))
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read labels, no drift asserted
  }

  for (const item of items) {
    const value = String(item.fields.value ?? '').trim()
    if (!value) continue
    const match = findLabel(live, value)
    if (!match) continue

    const expectedColor = normalizeColor(item.fields.color)
    const actualColor = normalizeColor(match.color)
    if (expectedColor !== undefined && actualColor !== undefined && expectedColor.toLowerCase() !== actualColor.toLowerCase()) {
      diffs.push({ field: `${value}.color`, expected: expectedColor, actual: actualColor, severity: 'info' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
