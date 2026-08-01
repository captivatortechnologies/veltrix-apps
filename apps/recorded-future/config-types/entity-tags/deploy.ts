import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildRecordedFutureClient,
  recordedFutureWriteError,
  type RecordedFutureClient,
} from '../../lib/recordedFutureApi'
import {
  COMPANY_LIST_TYPE,
  entityTagPaths,
  listsFromResponse,
  taggedEntitiesFromResponse,
  findCompanyList,
  findTaggedEntity,
  tagsOf,
  buildEntityRef,
  parseTags,
  sameTagSet,
  type ListInfo,
} from './_shared'

/**
 * Deploy Recorded Future entity tags over the List API:
 *   find:    POST /list/search  { name, type: company }   → locate the company-type list by name
 *   read:    GET  /list/{id}/entitiesWithTags             → the entity's CURRENT tags (for rollback)
 *   replace: POST /list/{id}/entity/tags { entity, tags } → set the FULL declared tag set
 *
 * "Replace Entity Tags" is authoritative — it sets the entity's COMPLETE tag set —
 * so unlike the additive Watch Lists type this is a true upsert of the whole set.
 * rollbackData records, per entity, the tags that were present BEFORE this deploy
 * so rollback can restore them exactly (a leftover-free undo — no list is created).
 *
 * The entity must already be a member of the list (the API tags an existing member);
 * a missing list or entity is reported as a failure rather than silently created.
 *
 * VERIFY the entity-resolution + tag request/response shapes against a live account.
 */
interface RollbackEntry {
  listName: string
  listId: string | null
  matchBy: string
  entityRef: string
  priorTags: string[]
  appliedTags: string[]
  changed: boolean
}

/** Locate a company-type list by name (best-effort — search failures yield no match). */
async function searchCompanyList(client: RecordedFutureClient, name: string): Promise<ListInfo | null> {
  try {
    const res = await client.post(entityTagPaths.search, { name, type: COMPANY_LIST_TYPE, limit: 100 })
    if (!res.ok) return null
    return findCompanyList(listsFromResponse(res.json), name)
  } catch {
    return null
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { credential, settings, component, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for entity-tag deployment' }
  }

  const built = buildRecordedFutureClient(credential, settings, component?.hostname)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previous: RollbackEntry[] = []
  const applied: string[] = []
  const failures: string[] = []

  for (const item of items) {
    const listName = String(item.fields.listName ?? '').trim()
    const entityRef = String(item.fields.entityRef ?? '').trim()
    const matchBy = String(item.fields.matchBy ?? 'id').trim()
    const desired = parseTags(item.fields.tags)
    if (!listName || !entityRef) continue

    const label = `${listName}/${entityRef}`
    const entry: RollbackEntry = {
      listName,
      listId: null,
      matchBy,
      entityRef,
      priorTags: [],
      appliedTags: desired,
      changed: false,
    }

    try {
      // 1. Resolve the company-type list by name.
      const list = await searchCompanyList(client, listName)
      if (!list?.id) {
        failures.push(`list "${listName}" not found (company-type)`)
        previous.push(entry)
        continue
      }
      entry.listId = String(list.id)

      // 2. Read the entity's current tags — both to confirm membership and for rollback.
      const rowsRes = await client.get(entityTagPaths.entitiesWithTags(entry.listId))
      if (!rowsRes.ok) {
        failures.push(`read tags for "${label}": ${recordedFutureWriteError(rowsRes)}`)
        previous.push(entry)
        continue
      }
      const row = findTaggedEntity(taggedEntitiesFromResponse(rowsRes.json), matchBy, entityRef)
      if (!row) {
        failures.push(`entity "${entityRef}" is not a member of list "${listName}"`)
        previous.push(entry)
        continue
      }
      entry.priorTags = [...tagsOf(row)]

      // 3. Skip when the live set already equals the declared set.
      if (sameTagSet(entry.priorTags, desired)) {
        previous.push(entry)
        applied.push(`${label} (unchanged)`)
        continue
      }

      // 4. Replace the entity's full tag set with the declared one.
      const res = await client.post(entityTagPaths.entityTags(entry.listId), {
        entity: buildEntityRef(matchBy, entityRef),
        tags: desired,
      })
      const error = recordedFutureWriteError(res)
      if (error) {
        failures.push(`set tags on "${label}": ${error}`)
        previous.push(entry)
        continue
      }

      entry.changed = true
      previous.push(entry)
      applied.push(label)
    } catch (error) {
      failures.push(`"${label}": ${error instanceof Error ? error.message : 'Unknown error'}`)
      previous.push(entry)
    }
  }

  if (failures.length > 0) {
    return {
      success: false,
      message: `Entity-tag deploy applied ${applied.length} target(s); ${failures.length} error(s): ${failures.join('; ')}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }

  return {
    success: true,
    message: `Applied tags to ${applied.length} entity(ies): ${applied.join(', ') || '(none)'}`,
    artifacts: { applied },
    rollbackData: { previous },
  }
}
