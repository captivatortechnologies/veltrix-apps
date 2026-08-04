import type { CanvasSnapshot, DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildElasticClient, parseJson, elasticErrorMessage, type ElasticClient } from '../../lib/elastic'
import {
  extractListSpecs,
  parseItemsArray,
  itemIdOf,
  type ValueListSpec,
  type LiveValueList,
  type LiveValueListItem,
} from './validate'

/** Per-item rollback state for an updated item (its prior live body). */
export interface ItemRollbackEntry {
  itemId: string
  prior: LiveValueListItem
}

export interface ValueListRollbackEntry {
  listId: string
  /** Whether the list container already existed before this deploy. */
  listExisted: boolean
  /** Prior list fields captured when an existing list was updated. */
  priorList?: Pick<LiveValueList, 'name' | 'description'>
  /** item ids this deploy CREATED (POSTed) — deleted on rollback. */
  createdItemIds: string[]
  /** items this deploy UPDATED (PUT) — restored to their prior body on rollback. */
  updatedItems: ItemRollbackEntry[]
  /** items this deploy DELETED — recreated from their prior body on rollback. */
  deletedItems: LiveValueListItem[]
}

/**
 * Deploy Elastic Security value lists via the Kibana Lists API.
 *
 * ONE canvas item = ONE list container with its items folded in. `type` is
 * IMMUTABLE after creation (Kibana's update endpoint does not accept it), so
 * it is sent on create only. There is no native container upsert, so the list
 * is reconciled list+match:
 *   - GET  /api/lists?id={id}  — 404 = absent
 *   - POST /api/lists          — create { id, name, description, type }
 *   - PUT  /api/lists          — update { id, name, description } (no type)
 *
 * Then the list's ITEMS are reconciled by id:
 *   - find live items (GET /api/lists/items/_find?list_id=)
 *   - POST items that are newly declared, PUT items that already exist
 *   - DELETE only items THIS config previously declared (from previousConfig)
 *     and no longer declares — items created by others are never pruned.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildElasticClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, kibanaUrl } = built

  const specs = extractListSpecs(ctx.canvas).filter((s) => s.id && s.name)
  // item ids this config declared on the PREVIOUS deploy, keyed by list id.
  const previouslyDeclared = declaredItemIdsByList(ctx.previousConfig)

  const rollbackState: ValueListRollbackEntry[] = []
  const createdListIds: string[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const label = spec.id
      const desiredItems = spec.itemsJson ? parseItemsArray(spec.itemsJson) : []
      if (spec.itemsJson && desiredItems === null) {
        throw new Error(`Value list "${label}": items are not a valid JSON array`)
      }
      const items = (desiredItems ?? []).filter((i) => itemIdOf(i))

      const entry: ValueListRollbackEntry = {
        listId: spec.id,
        listExisted: false,
        createdItemIds: [],
        updatedItems: [],
        deletedItems: [],
      }

      const existing = await findList(client, spec.id)

      if (!existing) {
        const res = await client.kibana('POST', '/api/lists', { body: buildCreateListBody(spec) })
        if (!res.ok) {
          throw new Error(`Failed to create value list "${label}": ${elasticErrorMessage(res)}`)
        }
        entry.listExisted = false
        createdListIds.push(spec.id)

        // A brand-new list has no live items — every declared item is a create.
        for (const raw of items) {
          await createItem(client, raw, spec)
          entry.createdItemIds.push(itemIdOf(raw))
        }
      } else {
        entry.listExisted = true
        entry.priorList = { name: existing.name, description: existing.description ?? '' }
        const res = await client.kibana('PUT', '/api/lists', { body: buildUpdateListBody(spec) })
        if (!res.ok) {
          throw new Error(`Failed to update value list "${label}": ${elasticErrorMessage(res)}`)
        }

        const live = await findItems(client, spec.id)
        const liveById = new Map(live.filter((i) => i.id).map((i) => [i.id as string, i]))
        const desiredIds = new Set(items.map((i) => itemIdOf(i)))

        for (const raw of items) {
          const itemId = itemIdOf(raw)
          if (liveById.has(itemId)) {
            entry.updatedItems.push({ itemId, prior: liveById.get(itemId) as LiveValueListItem })
            await updateItem(client, raw)
          } else {
            await createItem(client, raw, spec)
            entry.createdItemIds.push(itemId)
          }
        }

        // Prune ONLY item ids this config previously declared but no longer
        // declares — and only if they still exist live.
        const priorDeclared = previouslyDeclared.get(spec.id) ?? new Set<string>()
        for (const itemId of priorDeclared) {
          if (!desiredIds.has(itemId) && liveById.has(itemId)) {
            entry.deletedItems.push(liveById.get(itemId) as LiveValueListItem)
            await deleteItem(client, itemId)
          }
        }
      }

      rollbackState.push(entry)
      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} value list(s) to Kibana at ${kibanaUrl}: ${deployed.join(', ')}`,
      artifacts: { kibanaUrl, deployedLists: deployed },
      rollbackData: { previousState: rollbackState, createdListIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Value list deployment failed after ${deployed.length} of ${specs.length} list(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { kibanaUrl, deployedLists: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdListIds },
    }
  }
}

// --- Helpers ---

/** Find a value list by id; null on 404 (absent). */
export async function findList(client: ElasticClient, id: string): Promise<LiveValueList | null> {
  const res = await client.kibana('GET', '/api/lists', { query: { id } })
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`Failed to read value list "${id}": ${elasticErrorMessage(res)}`)
  }
  return parseJson<LiveValueList>(res.body)
}

/** Find all items for a list (GET .../items/_find returns { data: [...] }). */
export async function findItems(client: ElasticClient, listId: string): Promise<LiveValueListItem[]> {
  const res = await client.kibana('GET', '/api/lists/items/_find', { query: { list_id: listId, per_page: 10000 } })
  if (res.status === 404) return []
  if (!res.ok) {
    throw new Error(`Failed to list items for value list "${listId}": ${elasticErrorMessage(res)}`)
  }
  return parseJson<{ data?: LiveValueListItem[] }>(res.body)?.data ?? []
}

async function createItem(client: ElasticClient, raw: Record<string, unknown>, spec: ValueListSpec): Promise<void> {
  const res = await client.kibana('POST', '/api/lists/items', { body: buildItemBody(raw, spec, true) })
  if (!res.ok) {
    throw new Error(`Failed to create item "${itemIdOf(raw)}" in list "${spec.id}": ${elasticErrorMessage(res)}`)
  }
}

async function updateItem(client: ElasticClient, raw: Record<string, unknown>): Promise<void> {
  const res = await client.kibana('PUT', '/api/lists/items', { body: buildItemBody(raw, undefined, false) })
  if (!res.ok) {
    throw new Error(`Failed to update item "${itemIdOf(raw)}": ${elasticErrorMessage(res)}`)
  }
}

/** Delete a single item by id; tolerated as gone on 404. */
export async function deleteItem(client: ElasticClient, itemId: string): Promise<void> {
  const res = await client.kibana('DELETE', '/api/lists/items', { query: { id: itemId } })
  if (res.status !== 404 && !res.ok) {
    throw new Error(`Failed to delete item "${itemId}": ${elasticErrorMessage(res)}`)
  }
}

/** Build the container create body — the only place `type` is sent (immutable thereafter). */
export function buildCreateListBody(spec: ValueListSpec): Record<string, unknown> {
  return { id: spec.id, name: spec.name, description: spec.description ?? '', type: spec.type }
}

/** Build the container update body — `type` is intentionally omitted (immutable; Kibana's update endpoint does not accept it). */
export function buildUpdateListBody(spec: ValueListSpec): Record<string, unknown> {
  return { id: spec.id, name: spec.name, description: spec.description ?? '' }
}

/**
 * Build an item body. On create, `list_id` is included and `id` is optional
 * (server-generates one when omitted, but this app always supplies it for
 * reconcilability). On update, `list_id` is dropped (an item is keyed on `id`
 * and its `list_id` is immutable) and only `id` + `value` (+ `meta`) are sent.
 */
export function buildItemBody(
  raw: Record<string, unknown>,
  spec: ValueListSpec | undefined,
  forCreate: boolean,
): Record<string, unknown> {
  const body: Record<string, unknown> = { id: itemIdOf(raw), value: raw.value }
  if (raw.meta !== undefined) body.meta = raw.meta
  if (forCreate) {
    if (!spec) throw new Error('buildItemBody: spec is required when forCreate is true')
    body.list_id = spec.id
  }
  return body
}

/**
 * Map list id -> set of declared item ids from a canvas snapshot. Used to know
 * which items this config previously created so a subsequent deploy can prune
 * exactly those (and no others) when they are no longer declared.
 */
export function declaredItemIdsByList(canvas: CanvasSnapshot | null): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>()
  if (!canvas) return map
  for (const spec of extractListSpecs(canvas)) {
    if (!spec.id) continue
    const ids = new Set<string>()
    if (spec.itemsJson) {
      const items = parseItemsArray(spec.itemsJson)
      for (const item of items ?? []) {
        const id = itemIdOf(item)
        if (id) ids.add(id)
      }
    }
    map.set(spec.id, ids)
  }
  return map
}
