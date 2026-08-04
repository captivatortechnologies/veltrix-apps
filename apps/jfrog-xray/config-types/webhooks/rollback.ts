import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildXrayClient, xrayErrorMessage } from '../../lib/xrayApi'
import { webhookPath, type WebhookRollbackEntry } from './deploy'

/**
 * Roll back Xray webhooks using the state captured during deploy:
 *   - webhooks that were CREATED are deleted (`DELETE /api/v1/webhooks/{name}`).
 *   - webhooks that were UPDATED are restored to their captured prior body
 *     (`PUT /api/v1/webhooks/{name}`). If the prior body's `password` was not
 *     echoed back by the read (secret masking — see README Coverage notes),
 *     the restored webhook may need its password re-entered manually.
 * Processed in reverse deploy order, matching the platform's rollback convention.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildXrayClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previous = (ctx.rollbackData as { previous?: WebhookRollbackEntry[] } | null)?.previous
  if (!previous || previous.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previous].reverse()) {
      if (!entry.existed) {
        const res = await client.deleteResource(webhookPath(entry.name))
        if (!res.ok && res.status !== 404) {
          throw new Error(`Failed to delete webhook "${entry.name}": ${xrayErrorMessage(res)}`)
        }
      } else if (entry.prior) {
        const res = await client.request('PUT', webhookPath(entry.name), entry.prior)
        if (!res.ok) throw new Error(`Failed to restore webhook "${entry.name}": ${xrayErrorMessage(res)}`)
      }
      reverted.push(entry.name)
    }

    return { success: true, message: `Rolled back ${reverted.length} Xray webhook(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previous.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}
