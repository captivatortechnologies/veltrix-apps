import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildCloudflareClient, cloudflareErrorMessage } from '../../lib/cloudflare'
import type { PostureRuleRollbackEntry } from './deploy'
import type { LivePostureRule } from './validate'

/**
 * Roll back device posture rules using the state captured during deploy:
 *   - rules that were created are deleted (DELETE /devices/posture/{id})
 *   - rules that were updated are restored (PUT) to their prior body
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildCloudflareClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: PostureRuleRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.account('DELETE', `/devices/posture/${entry.id}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete posture rule "${entry.label}": ${cloudflareErrorMessage(res)}`)
          }
        }
      } else if (entry.id && entry.prior) {
        const res = await client.account('PUT', `/devices/posture/${entry.id}`, { body: restorePayload(entry.prior) })
        if (!res.ok) {
          throw new Error(`Failed to restore posture rule "${entry.label}": ${cloudflareErrorMessage(res)}`)
        }
      }
      reverted.push(entry.label)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} device posture rule(s): ${reverted.join(', ')}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} rule(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}

/** Restore body from the prior live rule — the core managed fields. */
function restorePayload(prior: LivePostureRule): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  if (prior.name !== undefined) body.name = prior.name
  if (prior.type !== undefined) body.type = prior.type
  if (prior.description !== undefined) body.description = prior.description
  if (prior.schedule !== undefined) body.schedule = prior.schedule
  if (prior.expiration !== undefined) body.expiration = prior.expiration
  if (Array.isArray(prior.match)) body.match = prior.match
  if (prior.input !== undefined) body.input = prior.input
  return body
}
