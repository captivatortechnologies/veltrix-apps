import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildTinesClient, tinesErrorMessage } from '../../lib/tinesApi'
import type { TagRollbackEntry } from './deploy'

/**
 * Undo a tags deploy from rollbackData.previousState (written by deploy()),
 * in reverse order:
 *   - a tag that was CREATED is deleted (DELETE /api/v1/tags/{id}?team_id=)
 *   - a tag that was UPDATED is restored (PUT) to its prior name + color
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildTinesClient(ctx.component?.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: TagRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: true, message: 'Nothing to roll back.' }
  }

  const reverted: string[] = []
  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.request('DELETE', `/tags/${entry.id}`, { query: { team_id: entry.teamId } })
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete tag "${entry.name}": ${tinesErrorMessage(res)}`)
          }
        }
      } else if (entry.id && entry.prior) {
        const body = { name: String(entry.prior.name ?? entry.name), color: String(entry.prior.color ?? '') }
        const res = await client.request('PUT', `/tags/${entry.id}`, { body })
        if (!res.ok) throw new Error(`Failed to restore tag "${entry.name}": ${tinesErrorMessage(res)}`)
      }
      reverted.push(entry.name)
    }

    return { success: true, message: `Rolled back ${reverted.length} tag(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
