import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildTenableClient, tenableErrorMessage } from '../../lib/tenable'
import type { PolicyRollbackEntry } from './deploy'

/**
 * Roll back scan policies using the state captured during deploy:
 *   - policies this deploy created are deleted (DELETE /policies/{id})
 *   - policies this deploy updated are PUT back to their captured prior state
 *     (PUT /policies/{id}/configure with the prior uuid + settings)
 *
 * A policy that is referenced by a scan cannot be deleted — Tenable answers the
 * DELETE with 405 Method Not Allowed. We surface that as a clear, actionable
 * message rather than a raw HTTP error, since the fix is to detach the scan.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildTenableClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: PolicyRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        // Deploy created this policy — remove it. 404 means it was never created
        // (or already removed), which is the desired end state. 405 means a scan
        // still references the policy, so Tenable refuses the delete.
        if (entry.id !== undefined) {
          const res = await client.request('DELETE', `/policies/${entry.id}`)
          if (res.status === 405) {
            throw new Error(
              `Cannot delete policy "${entry.name}" (id ${entry.id}) — it is in use by a scan. ` +
                'Delete or re-point the scan(s) referencing this policy, then retry the rollback.',
            )
          }
          if (!res.ok && res.status !== 404) {
            throw new Error(`Failed to delete policy "${entry.name}": ${tenableErrorMessage(res)}`)
          }
        }
      } else if (entry.id !== undefined && entry.prior?.settings) {
        // Deploy updated this policy — restore the captured prior state. Send the
        // prior template uuid at the top level (falling back to the current one)
        // and the prior settings object.
        const restore: Record<string, unknown> = { settings: entry.prior.settings }
        if (entry.prior.uuid) restore.uuid = entry.prior.uuid
        const res = await client.request('PUT', `/policies/${entry.id}/configure`, { body: restore })
        if (!res.ok) {
          throw new Error(`Failed to restore policy "${entry.name}": ${tenableErrorMessage(res)}`)
        }
      }

      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} policy(ies): ${reverted.join(', ')}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} policy(ies): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
