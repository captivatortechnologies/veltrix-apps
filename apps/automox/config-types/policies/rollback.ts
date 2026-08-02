import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildAutomoxClient, automoxErrorMessage } from '../../lib/automoxApi'
import type { PolicyRollbackEntry } from './deploy'

/**
 * Undo a Policies deploy from rollbackData.previousState (written by deploy):
 *   - a policy this deploy CREATED is deleted (DELETE /policies/{id}; 404 tolerated)
 *   - a policy this deploy UPDATED is restored (PUT /policies/{id}) to its prior
 *     managed body (name / policy_type_name / configuration / schedule / server_groups / notes)
 *
 * Applied over the Automox Console API, org-scoped via `o=<organizationId>`.
 * Reverses entries in the opposite order they were applied, matching the
 * dependency-safe convention used elsewhere in this repo (e.g. Wiz).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const previousState = (ctx.rollbackData as { previousState?: PolicyRollbackEntry[] })?.previousState
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
        // Deploy created this policy — remove it. 404 means it is already gone.
        const res = await client.request('DELETE', `/policies/${entry.id}`)
        if (res.status !== 404 && !res.ok) {
          throw new Error(`Failed to delete Policy "${entry.name}": ${automoxErrorMessage(res)}`)
        }
      } else if (entry.prior) {
        // Deploy updated this policy — restore the captured prior body.
        const res = await client.request('PUT', `/policies/${entry.id}`, { body: { ...entry.prior, id: entry.id } })
        if (!res.ok) throw new Error(`Failed to restore Policy "${entry.name}": ${automoxErrorMessage(res)}`)
      }

      reverted.push(entry.name)
    }

    return { success: true, message: `Rolled back ${reverted.length} Policy(ies): ${reverted.join(', ')}.` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} policy(ies): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
