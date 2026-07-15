import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildCloudflareClient, cloudflareErrorMessage } from '../../lib/cloudflare'
import type { ServiceTokenRollbackEntry } from './deploy'

/**
 * Roll back Access service tokens using the state captured during deploy:
 *   - tokens THIS deploy CREATED (existed:false) are deleted
 *     (DELETE /access/service_tokens/{id})
 *   - tokens that were UPDATED (existed:true) are restored (PUT) to their prior
 *     name/duration
 *
 * ⚠ SECURITY: pre-existing tokens are NEVER deleted — only tokens this deploy
 * created are removed. No secret is involved: the create response's write-only
 * client_secret was never captured, and PUT never rotates or returns it.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildCloudflareClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: ServiceTokenRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        // Only delete tokens THIS deploy created. Pre-existing tokens are never
        // deleted.
        if (entry.id) {
          const res = await client.account('DELETE', `/access/service_tokens/${entry.id}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete service token "${entry.label}": ${cloudflareErrorMessage(res)}`)
          }
        }
      } else if (entry.id && entry.prior?.name) {
        // Restore the prior name/duration (no secret is touched).
        const restore: Record<string, unknown> = { name: entry.prior.name }
        if (entry.prior.duration) restore.duration = entry.prior.duration
        const res = await client.account('PUT', `/access/service_tokens/${entry.id}`, { body: restore })
        if (!res.ok) {
          throw new Error(`Failed to restore service token "${entry.label}": ${cloudflareErrorMessage(res)}`)
        }
      }
      reverted.push(entry.label)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} service token(s): ${reverted.join(', ')}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} token(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
