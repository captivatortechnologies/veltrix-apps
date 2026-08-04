import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildOpenctiUrl, buildAuthHeader, graphql } from '../../lib/openctiApi'
import {
  LIST_CASE_TEMPLATES_QUERY,
  LIST_TASK_TEMPLATES_FOR_RESOLUTION_QUERY,
  caseTemplatesFromList,
  findCaseTemplate,
  normalizeText,
  resolveTaskTemplateIds,
  taskIdsOf,
  taskTemplateRefsFromList,
  toStringList,
} from './_shared'

/**
 * Drift for case templates: compare the description AND the resolved set of
 * attached task-template ids (order-insensitive) against the live case
 * template in OpenCTI (matched by name). A `task_template_names` entry that
 * doesn't resolve to a live task template is excluded from the "expected" set
 * rather than raising drift for a name this app can't yet turn into an id.
 * Best-effort — a case template that can't be matched (missing / transient
 * error) is skipped rather than raising false drift. Read-only: caseTemplates,
 * taskTemplates.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const base = buildOpenctiUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let live
  let liveTaskTemplates
  try {
    live = caseTemplatesFromList(await graphql<unknown>(base, headers, LIST_CASE_TEMPLATES_QUERY))
    liveTaskTemplates = taskTemplateRefsFromList(await graphql<unknown>(base, headers, LIST_TASK_TEMPLATES_FOR_RESOLUTION_QUERY))
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read live state, no drift asserted
  }

  for (const item of items) {
    const name = String(item.fields.name ?? '').trim()
    if (!name) continue
    const match = findCaseTemplate(live, name)
    if (!match) continue

    const expectedDescription = normalizeText(item.fields.description)
    const actualDescription = normalizeText(match.description)
    if (expectedDescription !== undefined && actualDescription !== undefined && expectedDescription !== actualDescription) {
      diffs.push({ field: `${name}.description`, expected: expectedDescription, actual: actualDescription, severity: 'info' })
    }

    const { ids: expectedTaskIds } = resolveTaskTemplateIds(toStringList(item.fields.task_template_names), liveTaskTemplates)
    const expectedSorted = expectedTaskIds.slice().sort()
    const actualSorted = taskIdsOf(match).slice().sort()
    if (JSON.stringify(expectedSorted) !== JSON.stringify(actualSorted)) {
      diffs.push({
        field: `${name}.tasks`,
        expected: expectedSorted.join(', ') || '(none)',
        actual: actualSorted.join(', ') || '(none)',
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
