import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildTinesClient, tinesErrorMessage } from '../../lib/tinesApi'
import type { FolderRollbackEntry } from './deploy'

/**
 * Undo a folders deploy from rollbackData.previousState (written by
 * deploy()), in REVERSE order — deploy applies parents before children, so
 * reversing deletes children before their parent:
 *   - a folder that was CREATED is deleted (DELETE /api/v1/folders/{id})
 *   - a folder that was UPDATED is restored (PUT) to its prior name + parent
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildTinesClient(ctx.component?.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: FolderRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: true, message: 'Nothing to roll back.' }
  }

  const reverted: string[] = []
  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.request('DELETE', `/folders/${entry.id}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete folder "${entry.name}": ${tinesErrorMessage(res)}`)
          }
        }
      } else if (entry.id && entry.prior) {
        const body = {
          name: String(entry.prior.name ?? entry.name),
          parent_folder_id: entry.prior.parent_folder_id ?? null,
        }
        const res = await client.request('PUT', `/folders/${entry.id}`, { body })
        if (!res.ok) throw new Error(`Failed to restore folder "${entry.name}": ${tinesErrorMessage(res)}`)
      }
      reverted.push(entry.name)
    }

    return { success: true, message: `Rolled back ${reverted.length} folder(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
