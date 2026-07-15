import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildCloudflareClient, cloudflareErrorMessage } from '../../lib/cloudflare'
import type { AccessGroupRollbackEntry } from './deploy'

/**
 * Roll back Access groups using the state captured during deploy:
 *   - groups that were created are deleted (DELETE /access/groups/{id})
 *   - groups that were updated are restored (PUT) to their prior rule sets
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildCloudflareClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: AccessGroupRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.account('DELETE', `/access/groups/${entry.id}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete Access group "${entry.label}": ${cloudflareErrorMessage(res)}`)
          }
        }
      } else if (entry.id && entry.prior) {
        const p = entry.prior
        const restore: Record<string, unknown> = {
          name: p.name,
          include: p.include ?? [],
        }
        if (Array.isArray(p.exclude)) restore.exclude = p.exclude
        if (Array.isArray(p.require)) restore.require = p.require
        const res = await client.account('PUT', `/access/groups/${entry.id}`, { body: restore })
        if (!res.ok) {
          throw new Error(`Failed to restore Access group "${entry.label}": ${cloudflareErrorMessage(res)}`)
        }
      }
      reverted.push(entry.label)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} Access group(s): ${reverted.join(', ')}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} group(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
