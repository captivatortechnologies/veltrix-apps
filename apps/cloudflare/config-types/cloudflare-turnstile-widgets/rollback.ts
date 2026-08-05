import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildCloudflareClient, cloudflareErrorMessage } from '../../lib/cloudflare'
import { buildPayload, type TurnstileWidgetRollbackEntry } from './deploy'

/**
 * Roll back Turnstile widgets using the state captured during deploy:
 *   - widgets that were created are deleted (DELETE /challenges/widgets/{sitekey})
 *   - widgets that were updated are restored (PUT) to their prior editable fields
 *
 * The secret is never part of this — it is write-only and was never captured.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildCloudflareClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: TurnstileWidgetRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.sitekey) {
          const res = await client.account('DELETE', `/challenges/widgets/${entry.sitekey}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete Turnstile widget "${entry.label}": ${cloudflareErrorMessage(res)}`)
          }
        }
      } else if (entry.sitekey && entry.prior) {
        const p = entry.prior
        const restore = buildPayload({
          sectionName: '',
          name: p.name ?? entry.label,
          mode: p.mode ?? 'managed',
          domains: p.domains ?? [],
          botFightMode: p.bot_fight_mode === true,
          region: p.region ?? 'world',
          offlabel: p.offlabel === true,
          ephemeralId: p.ephemeral_id === true,
          clearanceLevel: p.clearance_level ?? 'no_clearance',
        })
        const res = await client.account('PUT', `/challenges/widgets/${entry.sitekey}`, { body: restore })
        if (!res.ok) {
          throw new Error(`Failed to restore Turnstile widget "${entry.label}": ${cloudflareErrorMessage(res)}`)
        }
      }
      reverted.push(entry.label)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} Turnstile widget(s): ${reverted.join(', ')}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} widget(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
