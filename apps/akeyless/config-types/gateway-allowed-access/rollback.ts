import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildAkeylessClient, akeylessErrorMessage } from '../../lib/akeyless'
import { buildBody, type AllowedAccessRollbackEntry } from './deploy'

/**
 * Roll back allowed-access rules using the state captured during deploy:
 *   - rules that were created are deleted (POST /gateway-delete-allowed-access,
 *     tolerate 404)
 *   - rules that were updated have their prior fields restored via POST
 *     /gateway-update-allowed-access (no write-only secrets are involved in
 *     this config type, so restoration is complete).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildAkeylessClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: AllowedAccessRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        const res = await client.request('/gateway-delete-allowed-access', { name: entry.name })
        if (res.status !== 404 && !res.ok) {
          throw new Error(`Failed to delete allowed access rule "${entry.name}": ${akeylessErrorMessage(res)}`)
        }
      } else if (entry.priorSpec) {
        const res = await client.request('/gateway-update-allowed-access', buildBody(entry.priorSpec, { isUpdate: true }))
        if (!res.ok) throw new Error(`Failed to restore allowed access rule "${entry.name}": ${akeylessErrorMessage(res)}`)
      }

      reverted.push(entry.name)
    }

    return { success: true, message: `Rolled back ${reverted.length} allowed access rule(s): ${reverted.join(', ')}.` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} item(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
