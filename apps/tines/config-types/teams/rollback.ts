import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildTinesClient, tinesErrorMessage } from '../../lib/tinesApi'
import { buildTeamBody } from './_shared'
import type { TeamRollbackEntry } from './deploy'

/**
 * Undo a teams deploy from rollbackData.previousState (written by deploy()),
 * in reverse order:
 *   - a team that was CREATED is deleted (DELETE /api/v1/teams/{id})
 *   - a team that was RENAMED is restored (PUT) to its prior name
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildTinesClient(ctx.component?.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: TeamRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: true, message: 'Nothing to roll back.' }
  }

  const reverted: string[] = []
  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.request('DELETE', `/teams/${entry.id}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete team "${entry.name}": ${tinesErrorMessage(res)}`)
          }
        }
      } else if (entry.id && entry.prior) {
        const body = buildTeamBody({ itemName: entry.name, name: String(entry.prior.name ?? entry.name) })
        const res = await client.request('PUT', `/teams/${entry.id}`, { body })
        if (!res.ok) throw new Error(`Failed to restore team "${entry.name}": ${tinesErrorMessage(res)}`)
      }
      reverted.push(entry.name)
    }

    return { success: true, message: `Rolled back ${reverted.length} team(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
