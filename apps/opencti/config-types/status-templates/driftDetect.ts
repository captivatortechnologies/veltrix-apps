import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildOpenctiUrl, buildAuthHeader, graphql } from '../../lib/openctiApi'
import { LIST_STATUS_TEMPLATES_QUERY, findStatusTemplate, statusTemplatesFromList, normalizeColor } from './_shared'

/**
 * Drift for status templates: compare the color we declare against the live
 * template in OpenCTI (matched by name). Best-effort — a template that can't be
 * matched (missing / transient error) is skipped rather than raising false drift.
 * Read-only: statusTemplates.
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
    live = statusTemplatesFromList(await graphql<unknown>(base, headers, LIST_STATUS_TEMPLATES_QUERY))
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read status templates, no drift asserted
  }

  for (const item of items) {
    const name = String(item.fields.name ?? '').trim()
    if (!name) continue
    const match = findStatusTemplate(live, name)
    if (!match) continue

    const expectedColor = normalizeColor(item.fields.color)
    const actualColor = normalizeColor(match.color)
    if (expectedColor !== undefined && actualColor !== undefined && expectedColor.toLowerCase() !== actualColor.toLowerCase()) {
      diffs.push({ field: `${name}.color`, expected: expectedColor, actual: actualColor, severity: 'info' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
