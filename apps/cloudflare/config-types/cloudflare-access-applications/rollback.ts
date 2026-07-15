import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildCloudflareClient, cloudflareErrorMessage } from '../../lib/cloudflare'
import type { AccessAppRollbackEntry } from './deploy'
import type { LiveAccessApp } from './validate'

/**
 * Roll back Access applications using the state captured during deploy:
 *   - applications that were created are deleted (DELETE /access/apps/{id})
 *   - applications that were updated are restored (PUT) to their prior body
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildCloudflareClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: AccessAppRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.account('DELETE', `/access/apps/${entry.id}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete Access application "${entry.label}": ${cloudflareErrorMessage(res)}`)
          }
        }
      } else if (entry.id && entry.prior) {
        const res = await client.account('PUT', `/access/apps/${entry.id}`, { body: restorePayload(entry.prior) })
        if (!res.ok) {
          throw new Error(`Failed to restore Access application "${entry.label}": ${cloudflareErrorMessage(res)}`)
        }
      }
      reverted.push(entry.label)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} Access application(s): ${reverted.join(', ')}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} application(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}

/** Restore body from the prior live application — the core managed fields. */
function restorePayload(prior: LiveAccessApp): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  if (prior.name !== undefined) body.name = prior.name
  if (prior.domain !== undefined) body.domain = prior.domain
  if (prior.type !== undefined) body.type = prior.type
  if (prior.session_duration !== undefined) body.session_duration = prior.session_duration
  return body
}
