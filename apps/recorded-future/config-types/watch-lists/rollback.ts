import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildRecordedFutureClient, recordedFutureWriteError } from '../../lib/recordedFutureApi'
import { listPaths, buildEntityRef } from './_shared'

/**
 * Undo a Watch List deploy from rollbackData.previous (written by deploy()): for
 * each list, REMOVE exactly the entities this deploy added
 * (DELETE /list/{id}/entity/remove { entity }).
 *
 * IMPORTANT: the Recorded Future List API documents NO delete-list endpoint, so a
 * list this deploy CREATED cannot be deleted — rollback empties it (removes the
 * entities it added) and reports the leftover empty list for manual removal in the
 * Recorded Future portal.
 *
 * VERIFY the entity-remove request shape against a live Recorded Future account.
 */
interface RollbackEntry {
  name: string
  listType: string
  listId: string | null
  listExisted: boolean
  addedEntities: string[]
}

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { credential, settings, component } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: RollbackEntry[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for Watch List rollback' }
  }

  const built = buildRecordedFutureClient(credential, settings, component?.hostname)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  let removed = 0
  const leftoverLists: string[] = []
  const failures: string[] = []

  for (const entry of previous) {
    if (!entry.listId) continue
    for (const value of entry.addedEntities ?? []) {
      try {
        const res = await client.delete(listPaths.entityRemove(entry.listId), {
          entity: buildEntityRef(entry.listType, value),
        })
        const error = recordedFutureWriteError(res)
        if (error) {
          failures.push(`remove "${value}" from "${entry.name}": ${error}`)
          continue
        }
        removed++
      } catch (error) {
        failures.push(`remove "${value}" from "${entry.name}": ${error instanceof Error ? error.message : 'error'}`)
      }
    }
    if (!entry.listExisted) leftoverLists.push(entry.name)
  }

  const leftoverNote = leftoverLists.length
    ? ` ${leftoverLists.length} list(s) created by this deploy remain empty (no delete-list API — remove manually): ${leftoverLists.join(', ')}.`
    : ''

  if (failures.length > 0) {
    return {
      success: false,
      message: `Rollback removed ${removed} entity(ies); ${failures.length} error(s): ${failures.join('; ')}.${leftoverNote}`,
    }
  }

  return {
    success: true,
    message: `Rolled back Watch Lists: ${removed} entity(ies) removed.${leftoverNote}`,
  }
}
