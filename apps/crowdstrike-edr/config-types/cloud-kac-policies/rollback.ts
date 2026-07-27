import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient, falconFailure } from '../../lib/falcon'
import {
  deleteKacPolicy,
  updateKacPolicy,
  type KacPolicyRollbackEntry,
} from './deploy'

/**
 * Roll back KAC policies using the state captured during deploy:
 *   - policies that were created are disabled then deleted (enabled policies
 *     cannot be deleted directly)
 *   - policies that were updated are patched back to their prior name,
 *     description, and enablement
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: KacPolicyRollbackEntry[] })
    ?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        // Deploy created this policy — remove it. Disable first (enabled policies
        // cannot be deleted); 404 on delete means it never finished creating or
        // is already gone, which is the desired state.
        if (entry.id) {
          try {
            await updateKacPolicy(client, entry.id, entry.name, '', false)
          } catch {
            // Best effort — the policy may already be disabled or missing.
          }
          const res = await deleteKacPolicy(client, entry.id)
          const deleteFailure = res.status === 404 ? null : falconFailure(res)
          if (deleteFailure) {
            throw new Error(`Failed to delete KAC policy "${entry.name}": ${deleteFailure}`)
          }
        }
      } else if (entry.id && entry.prior) {
        // Deploy updated this policy — restore the captured prior scalar values.
        await updateKacPolicy(
          client,
          entry.id,
          entry.prior.name ?? entry.name,
          entry.prior.description ?? '',
          entry.prior.enabled ?? false,
        )
      }

      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} KAC policy(ies): ${reverted.join(', ')}`,
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
