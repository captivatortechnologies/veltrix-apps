import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildCortexClient } from '../../lib/cortexXdrApi'
import { ENDPOINT_GROUP_ENDPOINTS, findGroupByName, groupsFromReply, normalizeName } from './_shared'

/**
 * Drift for endpoint groups: compare the description + group_type we declare
 * against the live group in Cortex XDR. This read is REAL
 * (POST /endpoints/get_endpoint_groups/, the app's health probe). Best-effort —
 * a group that can't be matched (missing / transient error) is skipped rather
 * than raising false drift. The `filter` field is not diffed (its live JSON shape
 * is unverified).
 *
 * VERIFY the get_endpoint_groups response shape + field names against a live
 * Cortex XDR tenant.
 */
const COMPARED_FIELDS: Array<'description' | 'group_type'> = ['description', 'group_type']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, settings, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const built = buildCortexClient(component?.hostname, credential, settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  let live
  try {
    const res = await client.call(ENDPOINT_GROUP_ENDPOINTS.list, {})
    if (!res.ok) return { hasDrift: false, diffs } // best-effort: can't read, no drift asserted
    live = groupsFromReply(res.reply)
  } catch {
    return { hasDrift: false, diffs }
  }

  for (const item of items) {
    const name = String(item.fields.name ?? '').trim()
    if (!name) continue
    const match = findGroupByName(live, name)
    if (!match) continue

    for (const field of COMPARED_FIELDS) {
      const expected = String(item.fields[field] ?? '').trim()
      if (!expected) continue // an optional field the user left blank is not asserted
      const actual = String((match as Record<string, unknown>)[field] ?? '').trim()
      if (normalizeName(actual) !== normalizeName(expected)) {
        diffs.push({ field: `${name}.${field}`, expected, actual, severity: 'warning' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
