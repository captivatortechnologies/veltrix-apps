import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient, oktaErrorMessage } from '../../lib/okta'
import { type SmsTemplateRollbackEntry } from './deploy'

/**
 * Roll back custom SMS templates using the state captured during deploy:
 *   - templates this deploy CREATED are deleted (404 tolerated — already gone).
 *   - templates this deploy REPLACED are PUT back to their captured prior body.
 *
 * There is no lifecycle here (unlike network zones), so a created template can be
 * deleted directly. Rollback is keyed on the template id Okta returned, never on
 * the name.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: SmsTemplateRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        // Deploy created this template — remove it (404 = already deleted).
        if (entry.id) {
          const del = await client.request('DELETE', `/templates/sms/${entry.id}`)
          if (!del.ok && del.status !== 404) {
            throw new Error(`Failed to delete SMS template "${entry.name}": ${oktaErrorMessage(del)}`)
          }
        }
      } else if (entry.id && entry.prior) {
        // Deploy replaced this template — restore its captured prior body.
        const res = await client.request('PUT', `/templates/sms/${entry.id}`, { body: entry.prior })
        if (!res.ok) {
          throw new Error(`Failed to restore SMS template "${entry.name}": ${oktaErrorMessage(res)}`)
        }
      }

      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} SMS template(s): ${reverted.join(', ')}. Templates created by the deployment were deleted.`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} template(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
