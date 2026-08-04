import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildPagerDutyClient, pagerDutyErrorMessage } from '../../lib/pagerdutyApi'
import { webhookSubscriptionRestoreBody } from './_shared'
import type { WebhookSubscriptionRollbackEntry } from './deploy'

/**
 * Undo a webhook-subscriptions deploy from rollbackData.previousState (written
 * by deploy()), in reverse order:
 *   - a subscription that was CREATED is deleted (DELETE /webhook_subscriptions/{id})
 *   - a subscription that was UPDATED is restored (PUT) to its prior body
 * Applied over the PagerDuty REST API v2.
 *
 * NOTE: a restored subscription's custom_headers values come from PagerDuty's
 * OWN redacted GET response (captured as `prior` during deploy) — PagerDuty
 * masks header values on every read. The restore therefore reproduces header
 * NAMES correctly but may write back a redacted placeholder VALUE rather than
 * the original secret; re-enter any header value manually after a rollback
 * that restores an updated subscription (same limitation jfrog-xray documents
 * for its write-only webhook password field).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildPagerDutyClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: WebhookSubscriptionRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: true, message: 'Nothing to roll back.' }
  }

  const reverted: string[] = []
  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.request('DELETE', `/webhook_subscriptions/${encodeURIComponent(entry.id)}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete webhook subscription "${entry.description}": ${pagerDutyErrorMessage(res)}`)
          }
        }
      } else if (entry.id && entry.prior) {
        const body = { webhook_subscription: webhookSubscriptionRestoreBody(entry.prior) }
        const res = await client.request('PUT', `/webhook_subscriptions/${encodeURIComponent(entry.id)}`, { body })
        if (!res.ok) throw new Error(`Failed to restore webhook subscription "${entry.description}": ${pagerDutyErrorMessage(res)}`)
      }
      reverted.push(entry.description)
    }

    return { success: true, message: `Rolled back ${reverted.length} webhook subscription(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
