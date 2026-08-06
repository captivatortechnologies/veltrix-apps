import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildAkeylessClient, akeylessErrorMessage } from '../../lib/akeyless'
import { buildBody, type EventForwarderRollbackEntry } from './deploy'

/**
 * Roll back event forwarders using the state captured during deploy:
 *   - forwarders that were created are deleted (POST /event-forwarder-delete,
 *     tolerate 404)
 *   - forwarders that were updated have their prior non-secret fields
 *     restored via POST /event-forwarder-update-{type}. Write-only fields
 *     (webhook URLs, passwords, tokens, certs/keys) rotated by the deploy
 *     being rolled back CANNOT be restored.
 *   - Microsoft Teams is a special case: Akeyless requires its Webhook URL
 *     on EVERY update call (no "leave blank to keep unchanged"), and this
 *     app never captures it (write-only) - so a Teams forwarder that was
 *     updated cannot be safely restored by rollback at all; this is
 *     surfaced clearly instead of resending an empty/wrong URL.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildAkeylessClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: EventForwarderRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []
  const warnings: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        const res = await client.request('/event-forwarder-delete', { name: entry.name })
        if (res.status !== 404 && !res.ok) {
          throw new Error(`Failed to delete event forwarder "${entry.name}": ${akeylessErrorMessage(res)}`)
        }
      } else if (entry.priorSpec?.type === 'teams') {
        warnings.push(`"${entry.name}" (Microsoft Teams) could not be restored - its Webhook URL is write-only and required on every update.`)
      } else if (entry.priorSpec) {
        const res = await client.request(`/event-forwarder-update-${entry.priorSpec.type}`, buildBody(entry.priorSpec, { isUpdate: true }))
        if (!res.ok) throw new Error(`Failed to restore event forwarder "${entry.name}": ${akeylessErrorMessage(res)}`)
        warnings.push(`"${entry.name}": write-only credentials rotated by this deploy could not be restored by rollback.`)
      }

      reverted.push(entry.name)
    }

    const message = `Rolled back ${reverted.length} event forwarder(s): ${reverted.join(', ')}.${
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
