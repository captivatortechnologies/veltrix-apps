import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildAkeylessClient, akeylessErrorMessage } from '../../lib/akeyless'
import { buildTargetBody, type TargetRollbackEntry } from './deploy'

/**
 * Roll back targets using the state captured during deploy:
 *   - targets that were created are deleted (POST /target-delete, tolerate 404)
 *   - targets that were updated have their prior non-secret fields restored
 *     via POST /target-update-{type}. Write-only fields rotated by the
 *     deploy being rolled back (password, access key, cluster token/CA
 *     cert, client certs/keys) CANNOT be restored - Akeyless never returns
 *     them, so this app never captured them.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildAkeylessClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: TargetRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []
  const warnings: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        const res = await client.request('/target-delete', { name: entry.name })
        if (res.status !== 404 && !res.ok) {
          throw new Error(`Failed to delete target "${entry.name}": ${akeylessErrorMessage(res)}`)
        }
      } else if (entry.priorSpec) {
        const res = await client.request(`/target-update-${entry.priorSpec.type}`, buildTargetBody(entry.priorSpec, { isUpdate: true }))
        if (!res.ok) throw new Error(`Failed to restore target "${entry.name}": ${akeylessErrorMessage(res)}`)
        warnings.push(`"${entry.name}": write-only credentials rotated by this deploy could not be restored by rollback.`)
      }

      reverted.push(entry.name)
    }

    const message = `Rolled back ${reverted.length} target(s): ${reverted.join(', ')}.${warnings.length ? ' ' + warnings.join(' ') : ''}`
    return { success: true, message }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} item(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
