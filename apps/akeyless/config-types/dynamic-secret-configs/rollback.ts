import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildAkeylessClient, akeylessErrorMessage } from '../../lib/akeyless'
import { buildBody, type DynamicSecretRollbackEntry } from './deploy'

/**
 * Roll back dynamic secret configs using the state captured during deploy:
 *   - configs that were created are deleted (POST /dynamic-secret-delete,
 *     tolerate 404)
 *   - configs that were updated have their prior non-secret fields restored
 *     via POST /dynamic-secret-update-{type}. Write-only admin credentials
 *     rotated by the deploy being rolled back CANNOT be restored.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildAkeylessClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: DynamicSecretRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []
  const warnings: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        const res = await client.request('/dynamic-secret-delete', { name: entry.name })
        if (res.status !== 404 && !res.ok) {
          throw new Error(`Failed to delete dynamic secret config "${entry.name}": ${akeylessErrorMessage(res)}`)
        }
      } else if (entry.priorSpec) {
        const res = await client.request(`/dynamic-secret-update-${entry.priorSpec.type}`, buildBody(entry.priorSpec, { isUpdate: true }))
        if (!res.ok) throw new Error(`Failed to restore dynamic secret config "${entry.name}": ${akeylessErrorMessage(res)}`)
        warnings.push(`"${entry.name}": write-only admin credentials rotated by this deploy could not be restored by rollback.`)
      }

      reverted.push(entry.name)
    }

    const message = `Rolled back ${reverted.length} dynamic secret config(s): ${reverted.join(', ')}.${
      warnings.length ? ' ' + warnings.join(' ') : ''
    }`
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
