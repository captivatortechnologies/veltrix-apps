import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildRecordedFutureClient,
  recordedFutureWriteError,
  type RecordedFutureClient,
} from '../../lib/recordedFutureApi'
import {
  listPaths,
  listsFromResponse,
  entitiesFromResponse,
  entitySignatures,
  findList,
  buildEntityRef,
  parseEntities,
  normalize,
  type ListInfo,
} from './_shared'

/**
 * Deploy Recorded Future Watch Lists over the List API:
 *   find:   POST /list/search  { name, type, limit }  → match an existing list by name
 *   create: POST /list/create  { name, type }          → new list (records its id)
 *   read:   GET  /list/{id}/entities                    → current members (for reconcile)
 *   add:    POST /list/{id}/entity/add { entity }       → add each declared member
 *
 * The list NAME is the stable identity used to upsert. Adds are additive — a member
 * already present is skipped; members NOT declared here are left in place (this
 * foundation does not prune, to avoid deleting entities added out-of-band).
 *
 * rollbackData records, per list, whether the list already existed, its id, and the
 * exact entities THIS deploy added — so rollback can remove only what it added.
 *
 * VERIFY the entity-add request shape + entity-resolution semantics against a live
 * Recorded Future account.
 */
interface RollbackEntry {
  name: string
  listType: string
  listId: string | null
  listExisted: boolean
  addedEntities: string[]
}

/** Find an existing list by name + type (best-effort — search failures yield no match). */
async function searchList(
  client: RecordedFutureClient,
  name: string,
  type: string,
): Promise<ListInfo | null> {
  try {
    const res = await client.post(listPaths.search, { name, type, limit: 100 })
    if (!res.ok) return null
    return findList(listsFromResponse(res.json), name, type)
  } catch {
    return null
  }
}

/** Read a list's current entity signatures (best-effort — read failures yield an empty set). */
async function currentSignatures(client: RecordedFutureClient, listId: string): Promise<Set<string>> {
  try {
    const res = await client.get(listPaths.entities(listId))
    if (!res.ok) return new Set()
    return entitySignatures(entitiesFromResponse(res.json))
  } catch {
    return new Set()
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { credential, settings, component, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for Watch List deployment' }
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
    const name = String(item.fields.name ?? '').trim()
    const listType = String(item.fields.listType ?? '').trim()
    if (!name) continue

    const entry: RollbackEntry = { name, listType, listId: null, listExisted: false, addedEntities: [] }

    try {
      // 1. Resolve the list — reuse an existing one by name, else create it.
      const existing = await searchList(client, name, listType)
      if (existing?.id) {
        entry.listId = String(existing.id)
        entry.listExisted = true
      } else {
        const res = await client.post(listPaths.create, { name, type: listType })
        const error = recordedFutureWriteError(res)
        if (error) {
          failures.push(`create "${name}": ${error}`)
          previous.push(entry)
          continue
        }
        const created = res.json as ListInfo
        entry.listId = created?.id ? String(created.id) : null
      }

      if (!entry.listId) {
        failures.push(`create "${name}": no list id returned`)
        previous.push(entry)
        continue
      }

      // 2. Reconcile members — add every declared entity not already present.
      const present = await currentSignatures(client, entry.listId)
      for (const value of parseEntities(item.fields.entities)) {
        if (present.has(normalize(value))) continue
        const res = await client.post(listPaths.entityAdd(entry.listId), {
          entity: buildEntityRef(listType, value),
        })
        const error = recordedFutureWriteError(res)
        if (error) {
          failures.push(`add "${value}" to "${name}": ${error}`)
          continue
        }
        entry.addedEntities.push(value)
      }

      previous.push(entry)
      applied.push(name)
    } catch (error) {
      failures.push(`"${name}": ${error instanceof Error ? error.message : 'Unknown error'}`)
      previous.push(entry)
    }
  }

  if (failures.length > 0) {
    return {
      success: false,
      message: `Watch List deploy applied ${applied.length} list(s); ${failures.length} error(s): ${failures.join('; ')}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }

  return {
    success: true,
    message: `Applied ${applied.length} Watch List(s): ${applied.join(', ') || '(none)'}`,
    artifacts: { applied },
    rollbackData: { previous },
  }
}
