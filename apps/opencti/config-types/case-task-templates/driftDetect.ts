import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildOpenctiUrl, buildAuthHeader, graphql } from '../../lib/openctiApi'
import { LIST_TASK_TEMPLATES_QUERY, findTaskTemplate, normalizeText, taskTemplatesFromList } from './_shared'

/**
 * Drift for case task templates: compare the description we declare against
 * the live task template in OpenCTI (matched by name). Best-effort — a
 * template that can't be matched (missing / transient error) is skipped
 * rather than raising false drift. Read-only: taskTemplates.
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
    live = taskTemplatesFromList(await graphql<unknown>(base, headers, LIST_TASK_TEMPLATES_QUERY))
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read task templates, no drift asserted
  }

  for (const item of items) {
    const name = String(item.fields.name ?? '').trim()
    if (!name) continue
    const match = findTaskTemplate(live, name)
    if (!match) continue

    const expectedDescription = normalizeText(item.fields.description)
    const actualDescription = normalizeText(match.description)
    if (expectedDescription !== undefined && actualDescription !== undefined && expectedDescription !== actualDescription) {
      diffs.push({ field: `${name}.description`, expected: expectedDescription, actual: actualDescription, severity: 'info' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
