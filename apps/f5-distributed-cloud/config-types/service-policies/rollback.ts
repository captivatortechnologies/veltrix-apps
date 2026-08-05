import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildF5xcClient, f5xcErrorMessage } from '../../lib/f5xc'
import type { ServicePolicyRollbackEntry } from './deploy'

const OBJECT_PLURAL = 'service_policys'

/**
 * Roll back service policies using the state captured during deploy:
 *   - policies this deploy CREATED are deleted (a 404 on delete is treated
 *     as already-gone, not an error).
 *   - policies this deploy UPDATED are PUT back to their captured prior
 *     { metadata, spec }.
 * Rollback is keyed on NAME - F5 XC objects have no separate id.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildF5xcClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: ServicePolicyRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        const del = await client.remove(OBJECT_PLURAL, entry.name)
        if (!del.ok && del.status !== 404) {
          throw new Error(`Failed to delete service policy "${entry.name}": ${f5xcErrorMessage(del)}`)
        }
      } else if (entry.prior) {
        const res = await client.replace(OBJECT_PLURAL, entry.name, entry.prior)
        if (!res.ok) {
          throw new Error(`Failed to restore service policy "${entry.name}": ${f5xcErrorMessage(res)}`)
        }
      }
      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} service policy(ies): ${reverted.join(', ')}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} service policy(ies): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
