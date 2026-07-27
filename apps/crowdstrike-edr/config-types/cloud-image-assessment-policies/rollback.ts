import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient, falconFailure } from '../../lib/falcon'
import { IMAGE_POLICY_ENTITY, type ImagePolicyRollbackEntry } from './deploy'

/**
 * Roll back image assessment policies using the state captured during deploy:
 *   - policies that were created are deleted (DELETE …?id=<id>)
 *   - policies that were updated are patched back to their prior name,
 *     description, enablement and policy_data
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: ImagePolicyRollbackEntry[] })
    ?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        // Deploy created this policy — remove it. 404 means it never finished
        // creating or is already gone, which is the desired state.
        if (entry.id) {
          const res = await client.request(
            'DELETE',
            `${IMAGE_POLICY_ENTITY}?id=${encodeURIComponent(entry.id)}`,
          )
          const deleteFailure = res.status === 404 ? null : falconFailure(res)
          if (deleteFailure) {
            throw new Error(`Failed to delete policy "${entry.name}": ${deleteFailure}`)
          }
        }
      } else if (entry.id && entry.prior) {
        // Deploy updated this policy — restore the captured prior values.
        const restore: Record<string, unknown> = {
          name: entry.prior.name ?? entry.name,
          description: entry.prior.description ?? '',
        }
        if (entry.prior.is_enabled !== undefined) restore.is_enabled = entry.prior.is_enabled
        if (entry.prior.policy_data !== undefined) restore.policy_data = entry.prior.policy_data

        const res = await client.request(
          'PATCH',
          `${IMAGE_POLICY_ENTITY}?id=${encodeURIComponent(entry.id)}`,
          { body: restore },
        )
        const restoreFailure = falconFailure(res)
        if (restoreFailure) {
          throw new Error(`Failed to restore policy "${entry.name}": ${restoreFailure}`)
        }
      }

      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} image assessment policy(ies): ${reverted.join(', ')}`,
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
