import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildRecordedFutureClient, type RecordedFutureClient } from '../../lib/recordedFutureApi'
import {
  COMPANY_LIST_TYPE,
  entityTagPaths,
  listsFromResponse,
  taggedEntitiesFromResponse,
  findCompanyList,
  findTaggedEntity,
  tagsOf,
  parseTags,
} from './_shared'

/**
 * Drift for Entity Tags: for each declared target, confirm the company-type list and
 * entity exist and that the entity's live tag set EXACTLY matches the declared set.
 * Read-only:
 *   POST /list/search              → locate the company-type list by name
 *   GET  /list/{id}/entitiesWithTags → the entity's current tags
 *
 * Because "Replace Entity Tags" is authoritative (the declared set is the full set),
 * BOTH a declared tag that is absent AND a live tag that is not declared count as
 * drift. Best-effort — a list or entity that can't be found / read is reported as
 * missing rather than raising noisy false drift.
 *
 * VERIFY the search + entitiesWithTags response shapes against a live account.
 */
async function liveTags(
  client: RecordedFutureClient,
  listName: string,
  matchBy: string,
  entityRef: string,
): Promise<{ found: boolean; tags: Set<string> }> {
  const search = await client.post(entityTagPaths.search, { name: listName, type: COMPANY_LIST_TYPE, limit: 100 })
  if (!search.ok) return { found: false, tags: new Set() }
  const list = findCompanyList(listsFromResponse(search.json), listName)
  if (!list?.id) return { found: false, tags: new Set() }

  const rows = await client.get(entityTagPaths.entitiesWithTags(String(list.id)))
  if (!rows.ok) return { found: false, tags: new Set() }
  const row = findTaggedEntity(taggedEntitiesFromResponse(rows.json), matchBy, entityRef)
  if (!row) return { found: false, tags: new Set() }
  return { found: true, tags: tagsOf(row) }
}

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { credential, settings, component, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const built = buildRecordedFutureClient(credential, settings, component?.hostname)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  for (const item of items) {
    const listName = String(item.fields.listName ?? '').trim()
    const entityRef = String(item.fields.entityRef ?? '').trim()
    const matchBy = String(item.fields.matchBy ?? 'id').trim()
    if (!listName || !entityRef) continue
    const label = `${listName}/${entityRef}`
    const desired = new Set(parseTags(item.fields.tags))

    let state
    try {
      state = await liveTags(client, listName, matchBy, entityRef)
    } catch {
      continue // best-effort: transient error — no drift asserted for this target
    }

    if (!state.found) {
      diffs.push({ field: label, expected: 'present', actual: 'missing', severity: 'warning' })
      continue
    }

    for (const tag of desired) {
      if (!state.tags.has(tag)) {
        diffs.push({ field: `${label}.${tag}`, expected: 'tagged', actual: 'absent', severity: 'warning' })
      }
    }
    for (const tag of state.tags) {
      if (!desired.has(tag)) {
        diffs.push({ field: `${label}.${tag}`, expected: 'not-tagged', actual: 'present', severity: 'warning' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
