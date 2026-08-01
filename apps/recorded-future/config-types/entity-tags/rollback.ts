import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildRecordedFutureClient, recordedFutureWriteError } from '../../lib/recordedFutureApi'
import { entityTagPaths, buildEntityRef } from './_shared'

/**
 * Undo an entity-tag deploy from rollbackData.previous (written by deploy()): for
 * each entity this deploy CHANGED, restore the exact tag set it had BEFORE the
 * deploy by replacing tags again with the captured prior set
 * (POST /list/{id}/entity/tags { entity, tags: priorTags }).
 *
 * Because "Replace Entity Tags" is authoritative (it sets the COMPLETE set), this
 * is a clean, leftover-free undo — it never creates or deletes a list, and entities
 * this deploy did not change are skipped. If prior tags were empty, restore clears
 * the tags this deploy set.
 *
 * VERIFY the entity-tag request shape against a live Recorded Future account.
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

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { credential, settings, component } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: RollbackEntry[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for entity-tag rollback' }
  }

  const built = buildRecordedFutureClient(credential, settings, component?.hostname)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  let restored = 0
  const failures: string[] = []

  for (const entry of previous) {
    if (!entry.changed || !entry.listId) continue
    const label = `${entry.listName}/${entry.entityRef}`
    try {
      const res = await client.post(entityTagPaths.entityTags(entry.listId), {
        entity: buildEntityRef(entry.matchBy, entry.entityRef),
        tags: entry.priorTags ?? [],
      })
      const error = recordedFutureWriteError(res)
      if (error) {
        failures.push(`restore tags on "${label}": ${error}`)
        continue
      }
      restored++
    } catch (error) {
      failures.push(`restore tags on "${label}": ${error instanceof Error ? error.message : 'error'}`)
    }
  }

  if (failures.length > 0) {
    return {
      success: false,
      message: `Rollback restored ${restored} entity tag set(s); ${failures.length} error(s): ${failures.join('; ')}.`,
    }
  }

  return { success: true, message: `Rolled back entity tags: ${restored} entity(ies) restored.` }
}
