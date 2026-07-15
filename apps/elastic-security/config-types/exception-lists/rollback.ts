import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildElasticClient, elasticErrorMessage, type ElasticClient } from '../../lib/elastic'
import {
  buildItemBody,
  buildListBody,
  deleteItem,
  type ExceptionListRollbackEntry,
} from './deploy'
import type { ExceptionListSpec } from './validate'

/**
 * Roll back exception lists using the state captured during deploy:
 *   - a list this deploy CREATED is deleted (which cascades its items away)
 *   - a list that was UPDATED has its prior name/description/type restored, then
 *       - items this deploy created are deleted
 *       - items this deploy updated are restored to their prior body
 *       - items this deploy deleted are recreated from their prior body
 *
 * All deletes tolerate a 404 (already gone = the desired end state).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildElasticClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: ExceptionListRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      const label = entry.listId

      if (!entry.listExisted) {
        // Deploy created this list — delete it. Deleting the list container
        // cascades and removes every item it held (created here or not), so no
        // per-item cleanup is needed. 404 = already gone.
        const res = await client.kibana('DELETE', '/api/exception_lists', {
          query: { list_id: entry.listId, namespace_type: entry.namespaceType },
        })
        if (res.status !== 404 && !res.ok) {
          throw new Error(`Failed to delete exception list "${label}": ${elasticErrorMessage(res)}`)
        }
        reverted.push(label)
        continue
      }

      // Deploy updated an existing list — restore its prior container fields.
      if (entry.priorList) {
        const restoreSpec = specFromPrior(entry)
        const res = await client.kibana('PUT', '/api/exception_lists', { body: buildListBody(restoreSpec) })
        if (!res.ok) {
          throw new Error(`Failed to restore exception list "${label}": ${elasticErrorMessage(res)}`)
        }
      }

      // Items this deploy created — remove them.
      for (const itemId of entry.createdItemIds) {
        await deleteItem(client, itemId, entry.namespaceType)
      }

      // Items this deploy updated — restore each to its prior body.
      for (const updated of entry.updatedItems) {
        await restoreItem(client, updated.prior as Record<string, unknown>, entry, 'update')
      }

      // Items this deploy deleted — recreate each from its prior body.
      for (const deleted of entry.deletedItems) {
        await restoreItem(client, deleted as Record<string, unknown>, entry, 'create')
      }

      reverted.push(label)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} exception list(s): ${reverted.join(', ')}. Note: deleting a list removes it and every item it held.`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} list(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}

/** Rebuild the list spec needed to restore an updated list from its prior fields. */
function specFromPrior(entry: ExceptionListRollbackEntry): ExceptionListSpec {
  return {
    sectionName: entry.listId,
    listId: entry.listId,
    name: entry.priorList?.name ?? entry.listId,
    description: entry.priorList?.description ?? '',
    type: entry.priorList?.type ?? 'detection',
    namespaceType: entry.namespaceType,
  }
}

/** Restore a single item to its prior body via PUT (update) or POST (recreate). */
async function restoreItem(
  client: ElasticClient,
  prior: Record<string, unknown>,
  entry: ExceptionListRollbackEntry,
  mode: 'update' | 'create',
): Promise<void> {
  // Reuse the deploy body builder so server-managed fields are stripped and the
  // identity/managed fields are set consistently. namespace_type comes from the
  // captured entry; list_id from the entry for recreation.
  const spec: ExceptionListSpec = {
    sectionName: entry.listId,
    listId: entry.listId,
    name: typeof prior.name === 'string' ? prior.name : '',
    type: 'detection',
    namespaceType: entry.namespaceType,
  }
  const body = buildItemBody(prior, spec, mode === 'create')
  const res =
    mode === 'create'
      ? await client.kibana('POST', '/api/exception_lists/items', { body })
      : await client.kibana('PUT', '/api/exception_lists/items', { body })
  if (!res.ok) {
    const itemId = typeof prior.item_id === 'string' ? prior.item_id : '(unknown)'
    throw new Error(`Failed to restore item "${itemId}": ${elasticErrorMessage(res)}`)
  }
}
