import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildOneLoginClient, oneLoginErrorMessage } from '../../lib/oneLogin'
import { buildAppBody, type AppRollbackEntry } from './deploy'

/**
 * Roll back apps using the state captured during deploy:
 *   - apps that were created are deleted (DELETE /api/2/apps/{id}, tolerate 404)
 *   - apps that were updated are restored (PUT) to their prior writable state
 *     (name/description/notes/visible/allowAssumedSignin/policyId/tabId/
 *     provisioningEnabled/configuration/parameters)
 *
 * Never touches an app this deploy did not create or change.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildOneLoginClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: AppRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.request('DELETE', `/api/2/apps/${entry.id}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete app "${entry.name}": ${oneLoginErrorMessage(res)}`)
          }
        }
      } else if (entry.id && entry.prior) {
        const res = await client.request('PUT', `/api/2/apps/${entry.id}`, { body: buildAppBody(entry.prior) })
        if (!res.ok) {
          throw new Error(`Failed to restore app "${entry.name}": ${oneLoginErrorMessage(res)}`)
        }
      }

      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} app(s): ${reverted.join(', ')}.`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} app(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
