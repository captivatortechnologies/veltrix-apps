import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildCloudflareClient, cloudflareErrorMessage } from '../../lib/cloudflare'
import type { GatewayListRollbackEntry } from './deploy'

/**
 * Roll back Gateway lists using the state captured during deploy:
 *   - lists that were created are deleted (DELETE /gateway/lists/{id})
 *   - lists that were updated are restored (PATCH) to their prior name/description
 *     (and items when the captured prior included them)
 *
 * The /gateway/lists collection returns list metadata without entries, so a
 * captured `prior` may not carry `items` — we only restore items when present to
 * avoid wiping a list we cannot faithfully rebuild.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildCloudflareClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: GatewayListRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.account('DELETE', `/gateway/lists/${entry.id}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete Gateway list "${entry.label}": ${cloudflareErrorMessage(res)}`)
          }
        }
      } else if (entry.id && entry.prior) {
        const p = entry.prior
        const restore: Record<string, unknown> = {
          name: p.name,
          description: p.description ?? '',
        }
        if (Array.isArray(p.items)) {
          restore.items = p.items.map((it) => ({ value: it.value }))
        }
        const res = await client.account('PATCH', `/gateway/lists/${entry.id}`, { body: restore })
        if (!res.ok) {
          throw new Error(`Failed to restore Gateway list "${entry.label}": ${cloudflareErrorMessage(res)}`)
        }
      }
      reverted.push(entry.label)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} Gateway list(s): ${reverted.join(', ')}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} list(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
