import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildBaseUrl, buildAuthHeader, hasBasicAuth, getJson } from '../../lib/sumoLogicApi'
import { fieldsFromList, findField, isFieldEnabled, normalizeEnabled, type CustomField } from './_shared'

/**
 * Drift for custom fields: compare the enabled state we declare against the live
 * field in Sumo Logic (matched by name). Best-effort — a field that can't be
 * matched is skipped rather than raising false drift. Read-only: GET /fields.
 *
 * API: https://www.sumologic.com/help/docs/api/field-management/
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!hasBasicAuth(credential)) return { hasDrift: false, diffs }

  const base = buildBaseUrl(component, connectivity)
  const headers = buildAuthHeader(credential!)

  let live: CustomField[]
  try {
    live = fieldsFromList(await getJson<unknown>(`${base}/fields`, headers))
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read fields, no drift asserted
  }

  for (const item of items) {
    const fieldName = String(item.fields.fieldName ?? '').trim()
    const match = findField(live, fieldName)
    if (!match) continue

    const expectedEnabled = normalizeEnabled(item.fields.enabled)
    const actualEnabled = isFieldEnabled(match)
    if (actualEnabled !== expectedEnabled) {
      diffs.push({ field: `${fieldName}.enabled`, expected: expectedEnabled, actual: actualEnabled, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
