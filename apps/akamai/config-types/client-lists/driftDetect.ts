import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildAkamaiClient, CLIENT_LISTS_PATH, parseJson } from '../../lib/akamaiApi'
import { clientListsFromResponse, findClientList, parseTags, readClientListFields, sameStrings, valuesFromList } from './_shared'

/**
 * Drift for client lists: compare the entries, notes and tags we declare against
 * the live list in Akamai (matched by name). Best-effort — a list that can't be
 * matched (missing / transient error) is skipped rather than raising false drift.
 * Read-only: GET /client-list/v1/lists?includeItems=true.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []
  const diffs: DriftDiff[] = []

  const built = buildAkamaiClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  let live
  try {
    const res = await client.request('GET', CLIENT_LISTS_PATH, { query: { includeItems: true } })
    if (!res.ok) return { hasDrift: false, diffs }
    live = clientListsFromResponse(parseJson<unknown>(res.body))
  } catch {
    return { hasDrift: false, diffs }
  }

  for (const item of items) {
    const fields = readClientListFields(item.fields)
    const match = findClientList(live, fields.name)
    if (!match) continue

    const label = fields.name

    const liveValues = valuesFromList(match)
    if (!sameStrings(fields.values, liveValues)) {
      diffs.push({
        field: `${label}.entries`,
        expected: `${fields.values.length} entr${fields.values.length === 1 ? 'y' : 'ies'}`,
        actual: `${liveValues.length} entr${liveValues.length === 1 ? 'y' : 'ies'}`,
        severity: 'warning',
      })
    }

    const liveNotes = String(match.notes ?? '').trim()
    if (fields.notes !== liveNotes) {
      diffs.push({ field: `${label}.notes`, expected: fields.notes, actual: liveNotes, severity: 'info' })
    }

    const liveTags = parseTags(match.tags)
    if (!sameStrings(fields.tags, liveTags)) {
      diffs.push({ field: `${label}.tags`, expected: fields.tags.join(', '), actual: liveTags.join(', '), severity: 'info' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
