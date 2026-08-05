import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildInsightVMClient, insightVMErrorMessage } from '../../lib/insightvm'
import type { OverrideRollbackEntry } from './deploy'

/**
 * Roll back policy overrides using the state captured during deploy. Because
 * deploy is CREATE/skip only, rollback simply deletes the overrides we created
 * (DELETE /policy_overrides/{id}); overrides that already existed were skipped
 * and are left in place.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildInsightVMClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: OverrideRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const created = previousState.filter((e) => !e.existed && e.id != null)
  if (created.length === 0) {
    return { success: true, message: 'Nothing to roll back — no policy overrides were created by this deployment' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...created].reverse()) {
      const res = await client.request('DELETE', `/policy_overrides/${entry.id}`)
      if (res.status !== 404 && !res.ok) {
        throw new Error(`Failed to delete policy override for ${entry.label}: ${insightVMErrorMessage(res)}`)
      }
      reverted.push(entry.label)
    }

    return { success: true, message: `Rolled back ${reverted.length} policy override(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${created.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
