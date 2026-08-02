import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildAutomoxClient, automoxErrorMessage } from '../../lib/automoxApi'
import type { ServerGroupRollbackEntry } from './deploy'

/**
 * Undo a Server Groups deploy from rollbackData.previousState (written by
 * deploy):
 *   - a group this deploy CREATED is deleted (DELETE /servergroups/{id}; 404
 *     tolerated). Per the Automox API, deleting a group moves any devices in
 *     it to the organization's Default Group — expected, not an error.
 *   - a group this deploy UPDATED is restored (PUT /servergroups/{id}) to its
 *     prior managed body.
 *
 * Applied over the Automox Console API, org-scoped via `o=<organizationId>`.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const previousState = (ctx.rollbackData as { previousState?: ServerGroupRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: true, message: 'Nothing to roll back.' }
  }

  const built = buildAutomoxClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const reverted: string[] = []
  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.id) {
        reverted.push(entry.name)
        continue
      }

      if (!entry.existed) {
        const res = await client.request('DELETE', `/servergroups/${entry.id}`)
        if (res.status !== 404 && !res.ok) {
          throw new Error(`Failed to delete Server Group "${entry.name}": ${automoxErrorMessage(res)}`)
        }
      } else if (entry.prior) {
        const res = await client.request('PUT', `/servergroups/${entry.id}`, { body: entry.prior })
        if (!res.ok) throw new Error(`Failed to restore Server Group "${entry.name}": ${automoxErrorMessage(res)}`)
      }

      reverted.push(entry.name)
    }

    return { success: true, message: `Rolled back ${reverted.length} Server Group(s): ${reverted.join(', ')}.` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} group(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
