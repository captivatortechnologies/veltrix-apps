import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildZscalerClient, zscalerErrorMessage } from '../../lib/zscaler'
import type { DlpTemplateRollbackEntry } from './deploy'

/**
 * Roll back ZIA DLP notification templates using the state captured during
 * deploy:
 *   - templates that were created are deleted (DELETE /dlpNotificationTemplates/{id})
 *   - templates that were updated are restored (PUT) to their prior body
 * Reverting is itself a staged change, so this activates once at the end.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: DlpTemplateRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    // Reverse order so newer changes are undone first.
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id != null) {
          const res = await client.zia('DELETE', `/dlpNotificationTemplates/${entry.id}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete DLP notification template "${entry.name}": ${zscalerErrorMessage(res)}`)
          }
        }
      } else if (entry.id != null && entry.prior) {
        const restore = {
          name: entry.prior.name ?? entry.name,
          subject: entry.prior.subject ?? '',
          plainTextMessage: entry.prior.plainTextMessage ?? '',
          htmlMessage: entry.prior.htmlMessage ?? '',
          tlsEnabled: entry.prior.tlsEnabled === true,
          attachContent: entry.prior.attachContent === true,
        }
        const res = await client.zia('PUT', `/dlpNotificationTemplates/${entry.id}`, { body: restore })
        if (!res.ok) {
          throw new Error(`Failed to restore DLP notification template "${entry.name}": ${zscalerErrorMessage(res)}`)
        }
      }
      reverted.push(entry.name)
    }

    const act = await client.activate()
    if (!act.ok) {
      return {
        success: false,
        message: `Reverted ${reverted.length} DLP notification template(s) but activation failed: ${zscalerErrorMessage(
          act,
        )}. Re-run rollback to retry activation.`,
      }
    }

    return {
      success: true,
      message: `Rolled back and activated ${reverted.length} ZIA DLP notification template(s): ${reverted.join(', ')}`,
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
