import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildAkamaiClient, NETWORK_LISTS_PATH, parseJson } from '../../lib/akamaiApi'
import { findList, listsFromResponse, readListFields, sameElements } from './_shared'

/**
 * Drift for network lists: compare the elements + description we declare against
 * the live list in Akamai (matched by name). Best-effort — a list that can't be
 * matched (missing / transient error) is skipped rather than raising false drift.
 * Read-only: GET /network-list/v2/network-lists?includeElements=true.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []
  const diffs: DriftDiff[] = []

  const built = buildAkamaiClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  let live
  try {
    const res = await client.request('GET', NETWORK_LISTS_PATH, { query: { includeElements: true } })
    if (!res.ok) return { hasDrift: false, diffs }
    live = listsFromResponse(parseJson<unknown>(res.body))
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read lists, no drift asserted
  }

  for (const item of items) {
    const fields = readListFields(item.fields)
    const match = findList(live, fields.name)
    if (!match) continue

    const label = fields.name

    const liveElements = Array.isArray(match.list) ? match.list : []
    if (!sameElements(fields.elements, liveElements)) {
      diffs.push({
        field: `${label}.elements`,
        expected: `${fields.elements.length} element(s)`,
        actual: `${liveElements.length} element(s)`,
        severity: 'warning',
      })
    }

    const liveDescription = String(match.description ?? '').trim()
    if (fields.description !== liveDescription) {
      diffs.push({ field: `${label}.description`, expected: fields.description, actual: liveDescription, severity: 'info' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
