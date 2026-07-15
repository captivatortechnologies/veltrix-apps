import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildTenableClient, tenableErrorMessage } from '../../lib/tenable'
import type { AgentGroupRollbackEntry } from './deploy'

/**
 * Roll back agent groups using the state captured during deploy:
 *   - groups that were created are deleted (DELETE /scanners/{id}/agent-groups/{gid})
 *   - groups that were updated are restored (PUT) to their prior name
 *
 * Rollback is keyed on the numeric id captured at deploy time, never on the
 * name. Deleting an agent group only removes the grouping — the agents
 * themselves are untouched.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildTenableClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: AgentGroupRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      const label = `${entry.name} (scanner ${entry.scannerId})`

      if (!entry.existed) {
        // Deploy created this group — remove it. 404 means it is already gone
        // (or was never created), which is the desired end state.
        if (entry.id !== undefined) {
          const res = await client.request(
            'DELETE',
            `/scanners/${entry.scannerId}/agent-groups/${entry.id}`,
          )
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete agent group "${label}": ${tenableErrorMessage(res)}`)
          }
        }
      } else if (entry.id !== undefined && entry.prior?.name !== undefined) {
        // Deploy updated this group — restore the captured prior name.
        const res = await client.request(
          'PUT',
          `/scanners/${entry.scannerId}/agent-groups/${entry.id}`,
          { body: { name: entry.prior.name } },
        )
        if (!res.ok) {
          throw new Error(`Failed to restore agent group "${label}": ${tenableErrorMessage(res)}`)
        }
      }

      reverted.push(label)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} agent group(s): ${reverted.join(', ')}.`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} group(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
