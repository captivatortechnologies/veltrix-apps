import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildElasticClient, elasticErrorMessage, type ElasticClient } from '../../lib/elastic'
import { buildItemBody, buildUpdateListBody, deleteItem, type ValueListRollbackEntry } from './deploy'
import type { ValueListSpec } from './validate'

/**
 * Roll back value lists using the state captured during deploy:
 *   - a list this deploy CREATED is deleted (Kibana cascades and removes every
 *     item it held)
 *   - a list that was UPDATED has its prior name/description restored, then
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

  const previousState = (ctx.rollbackData as { previousState?: ValueListRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      const label = entry.listId

      if (!entry.listExisted) {
        const res = await client.kibana('DELETE', '/api/lists', { query: { id: entry.listId } })
        if (res.status !== 404 && !res.ok) {
          throw new Error(`Failed to delete value list "${label}": ${elasticErrorMessage(res)}`)
        }
        reverted.push(label)
        continue
      }

      if (entry.priorList) {
        const restoreSpec: ValueListSpec = {
          sectionName: entry.listId,
          id: entry.listId,
          name: entry.priorList.name ?? entry.listId,
          description: entry.priorList.description ?? '',
          type: 'keyword',
        }
        const res = await client.kibana('PUT', '/api/lists', { body: buildUpdateListBody(restoreSpec) })
        if (!res.ok) {
          throw new Error(`Failed to restore value list "${label}": ${elasticErrorMessage(res)}`)
        }
      }

      for (const itemId of entry.createdItemIds) {
        await deleteItem(client, itemId)
      }

      for (const updated of entry.updatedItems) {
        await restoreItem(client, updated.prior as Record<string, unknown>, entry, 'update')
      }

      for (const deleted of entry.deletedItems) {
        await restoreItem(client, deleted as Record<string, unknown>, entry, 'create')
      }

      reverted.push(label)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} value list(s): ${reverted.join(', ')}. Note: deleting a list removes it and every item it held.`,
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

/** Restore a single item to its prior body via PUT (update) or POST (recreate). */
async function restoreItem(
  client: ElasticClient,
  prior: Record<string, unknown>,
  entry: ValueListRollbackEntry,
  mode: 'update' | 'create',
): Promise<void> {
  const spec: ValueListSpec = { sectionName: entry.listId, id: entry.listId, name: entry.listId, type: 'keyword' }
  const body = buildItemBody(prior, mode === 'create' ? spec : undefined, mode === 'create')
  const res =
    mode === 'create'
      ? await client.kibana('POST', '/api/lists/items', { body })
      : await client.kibana('PUT', '/api/lists/items', { body })
  if (!res.ok) {
    const itemId = typeof prior.id === 'string' ? prior.id : '(unknown)'
    throw new Error(`Failed to restore item "${itemId}": ${elasticErrorMessage(res)}`)
  }
}
