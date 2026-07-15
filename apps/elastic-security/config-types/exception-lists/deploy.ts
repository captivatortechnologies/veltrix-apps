import type { CanvasSnapshot, DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildElasticClient,
  parseJson,
  elasticErrorMessage,
  type ElasticClient,
} from '../../lib/elastic'
import {
  extractListSpecs,
  parseItemsArray,
  itemIdOf,
  SERVER_MANAGED_FIELDS,
  type ExceptionListSpec,
  type LiveExceptionList,
  type LiveExceptionItem,
} from './validate'

/** Per-item rollback state for an updated item (its prior live body). */
export interface ItemRollbackEntry {
  itemId: string
  prior: LiveExceptionItem
}

export interface ExceptionListRollbackEntry {
  listId: string
  namespaceType: string
  /** Whether the list container already existed before this deploy. */
  listExisted: boolean
  /** Prior list fields captured when an existing list was updated. */
  priorList?: Pick<LiveExceptionList, 'name' | 'description' | 'type'>
  /** item_ids this deploy CREATED (POSTed) — deleted on rollback. */
  createdItemIds: string[]
  /** items this deploy UPDATED (PUT) — restored to their prior body on rollback. */
  updatedItems: ItemRollbackEntry[]
  /** items this deploy DELETED — recreated from their prior body on rollback. */
  deletedItems: LiveExceptionItem[]
}

/**
 * Deploy Elastic Security exception lists via the Kibana Exceptions API.
 *
 * ONE canvas item = ONE exception LIST container with its items folded in. There
 * is NO native upsert, so the list is reconciled list+match:
 *   - GET  /api/exception_lists?list_id={id}  — 404 = absent
 *   - POST /api/exception_lists               — create (capture created)
 *   - PUT  /api/exception_lists               — update (capture prior for rollback)
 *
 * Then the list's ITEMS are reconciled by item_id:
 *   - find live items (GET /api/exception_lists/items/_find?list_id=)
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

  const specs = extractListSpecs(ctx.canvas).filter((s) => s.listId && s.name)
  // Item_ids this config declared on the PREVIOUS deploy, keyed by list_id.
  // Used to prune only items this config created and no longer declares.
  const previouslyDeclared = declaredItemIdsByList(ctx.previousConfig)

  const rollbackState: ExceptionListRollbackEntry[] = []
  const createdListIds: string[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const label = spec.listId
      const desiredItems = spec.itemsJson ? parseItemsArray(spec.itemsJson) : []
      if (spec.itemsJson && desiredItems === null) {
        throw new Error(`Exception list "${label}": items are not a valid JSON array`)
      }
      const items = (desiredItems ?? []).filter((i) => itemIdOf(i))

      const entry: ExceptionListRollbackEntry = {
        listId: spec.listId,
        namespaceType: spec.namespaceType,
        listExisted: false,
        createdItemIds: [],
        updatedItems: [],
        deletedItems: [],
      }

      const existing = await findList(client, spec.listId, spec.namespaceType)

      if (!existing) {
        // Create the list container.
        const res = await client.kibana('POST', '/api/exception_lists', { body: buildListBody(spec) })
        if (!res.ok) {
          throw new Error(`Failed to create exception list "${label}": ${elasticErrorMessage(res)}`)
        }
        entry.listExisted = false
        createdListIds.push(spec.listId)

        // A brand-new list has no live items — every declared item is a create.
        for (const raw of items) {
          await createItem(client, raw, spec)
          entry.createdItemIds.push(itemIdOf(raw))
        }
      } else {
        // Update the list container in place, capturing the prior fields.
        entry.listExisted = true
        entry.priorList = {
          name: existing.name,
          description: existing.description ?? '',
          type: existing.type,
        }
        const res = await client.kibana('PUT', '/api/exception_lists', { body: buildListBody(spec) })
        if (!res.ok) {
          throw new Error(`Failed to update exception list "${label}": ${elasticErrorMessage(res)}`)
        }

        // Reconcile items by item_id against the live set.
        const live = await findItems(client, spec.listId, spec.namespaceType)
        const liveById = new Map(live.filter((i) => i.item_id).map((i) => [i.item_id as string, i]))
        const desiredIds = new Set(items.map((i) => itemIdOf(i)))

        for (const raw of items) {
          const itemId = itemIdOf(raw)
          if (liveById.has(itemId)) {
            entry.updatedItems.push({ itemId, prior: liveById.get(itemId) as LiveExceptionItem })
            await updateItem(client, raw, spec)
          } else {
            await createItem(client, raw, spec)
            entry.createdItemIds.push(itemId)
          }
        }

        // Prune ONLY item_ids this config previously declared but no longer
        // declares — and only if they still exist live. Items authored directly
        // in Kibana (or by another config) are never in previouslyDeclared, so
        // they are never touched.
        const priorDeclared = previouslyDeclared.get(spec.listId) ?? new Set<string>()
        for (const itemId of priorDeclared) {
          if (!desiredIds.has(itemId) && liveById.has(itemId)) {
            entry.deletedItems.push(liveById.get(itemId) as LiveExceptionItem)
            await deleteItem(client, itemId, spec.namespaceType)
          }
        }
      }

      rollbackState.push(entry)
      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} exception list(s) to Kibana at ${kibanaUrl}: ${deployed.join(', ')}`,
      artifacts: { kibanaUrl, deployedLists: deployed },
      rollbackData: { previousState: rollbackState, createdListIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Exception list deployment failed after ${deployed.length} of ${specs.length} list(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { kibanaUrl, deployedLists: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdListIds },
    }
  }
}

// --- Helpers ---

/** Find an exception list by list_id; null on 404 (absent). */
export async function findList(
  client: ElasticClient,
  listId: string,
  namespaceType: string,
): Promise<LiveExceptionList | null> {
  const res = await client.kibana('GET', '/api/exception_lists', {
    query: { list_id: listId, namespace_type: namespaceType },
  })
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`Failed to read exception list "${listId}": ${elasticErrorMessage(res)}`)
  }
  return parseJson<LiveExceptionList>(res.body)
}

/** Find all items for a list (GET .../items/_find returns { data: [...] }). */
export async function findItems(
  client: ElasticClient,
  listId: string,
  namespaceType: string,
): Promise<LiveExceptionItem[]> {
  const res = await client.kibana('GET', '/api/exception_lists/items/_find', {
    query: { list_id: listId, namespace_type: namespaceType, per_page: 10000 },
  })
  if (res.status === 404) return []
  if (!res.ok) {
    throw new Error(`Failed to list items for exception list "${listId}": ${elasticErrorMessage(res)}`)
  }
  return parseJson<{ data?: LiveExceptionItem[] }>(res.body)?.data ?? []
}

async function createItem(
  client: ElasticClient,
  raw: Record<string, unknown>,
  spec: ExceptionListSpec,
): Promise<void> {
  const res = await client.kibana('POST', '/api/exception_lists/items', {
    body: buildItemBody(raw, spec, true),
  })
  if (!res.ok) {
    throw new Error(
      `Failed to create item "${itemIdOf(raw)}" in list "${spec.listId}": ${elasticErrorMessage(res)}`,
    )
  }
}

async function updateItem(
  client: ElasticClient,
  raw: Record<string, unknown>,
  spec: ExceptionListSpec,
): Promise<void> {
  const res = await client.kibana('PUT', '/api/exception_lists/items', {
    body: buildItemBody(raw, spec, false),
  })
  if (!res.ok) {
    throw new Error(
      `Failed to update item "${itemIdOf(raw)}" in list "${spec.listId}": ${elasticErrorMessage(res)}`,
    )
  }
}

/** Delete a single item by item_id; tolerated as gone on 404. */
export async function deleteItem(
  client: ElasticClient,
  itemId: string,
  namespaceType: string,
): Promise<void> {
  const res = await client.kibana('DELETE', '/api/exception_lists/items', {
    query: { item_id: itemId, namespace_type: namespaceType },
  })
  if (res.status !== 404 && !res.ok) {
    throw new Error(`Failed to delete item "${itemId}": ${elasticErrorMessage(res)}`)
  }
}

/** Build the list container body (used by both POST and PUT — PUT keys on list_id). */
export function buildListBody(spec: ExceptionListSpec): Record<string, unknown> {
  return {
    list_id: spec.listId,
    name: spec.name,
    // Always send description so clearing it on the canvas converges the live list.
    description: spec.description ?? '',
    type: spec.type,
    namespace_type: spec.namespaceType,
  }
}

/**
 * Build an item body from a raw authored item. Strips server-managed fields so a
 * pasted export round-trips, then forces the identity/managed fields. On create
 * list_id is included; on update it is dropped (an item is keyed on item_id and
 * its list_id is immutable).
 */
export function buildItemBody(
  raw: Record<string, unknown>,
  spec: ExceptionListSpec,
  forCreate: boolean,
): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    if ((SERVER_MANAGED_FIELDS as readonly string[]).includes(key)) continue
    body[key] = value
  }
  body.item_id = itemIdOf(raw)
  body.name = typeof raw.name === 'string' ? raw.name : ''
  body.type = typeof raw.type === 'string' && raw.type ? raw.type : 'simple'
  body.namespace_type = spec.namespaceType
  body.entries = Array.isArray(raw.entries) ? raw.entries : []
  if (forCreate) {
    body.list_id = spec.listId
  } else {
    delete body.list_id
  }
  return body
}

/**
 * Map list_id -> set of declared item_ids from a canvas snapshot. Used to know
 * which items this config previously created so a subsequent deploy can prune
 * exactly those (and no others) when they are no longer declared.
 */
export function declaredItemIdsByList(canvas: CanvasSnapshot | null): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>()
  if (!canvas) return map
  for (const spec of extractListSpecs(canvas)) {
    if (!spec.listId) continue
    const ids = new Set<string>()
    if (spec.itemsJson) {
      const items = parseItemsArray(spec.itemsJson)
      for (const item of items ?? []) {
        const id = itemIdOf(item)
        if (id) ids.add(id)
      }
    }
    map.set(spec.listId, ids)
  }
  return map
}
