import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildTinesClient, tinesErrorMessage } from '../../lib/tinesApi'
import type { TeamMemberRollbackEntry } from './deploy'

/**
 * Undo a Team Members deploy from rollbackData.previousState (written by
 * deploy()), in reverse order. Only members THIS deploy invited are removed
 * (POST /api/v1/teams/{team_id}/remove_member) — a member who already
 * existed on the team is never touched by rollback, matching the additive-
 * only deploy semantics.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildTinesClient(ctx.component?.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: TeamMemberRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: true, message: 'Nothing to roll back.' }
  }

  const reverted: string[] = []
  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.invited || !entry.userId) continue
      const res = await client.request('POST', `/teams/${entry.teamId}/remove_member`, { body: { user_id: entry.userId } })
      if (res.status !== 404 && !res.ok) {
        throw new Error(`Failed to remove "${entry.email}" from team ${entry.teamId}: ${tinesErrorMessage(res)}`)
      }
      reverted.push(entry.email)
    }

    return {
      success: true,
      message: reverted.length > 0 ? `Removed ${reverted.length} invited member(s): ${reverted.join(', ')}` : 'Nothing to roll back — no members were invited by this deploy.',
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}
