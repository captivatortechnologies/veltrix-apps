import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildTeleportClient, teleportErrorMessage } from '../../lib/teleport'
import { updateBot } from './deploy'
import type { BotRollbackEntry } from './deploy'

/**
 * Roll back Machine ID bots using the state captured during deploy:
 *   - bots this deploy CREATED are deleted (DELETE .../machine-id/bot/{name}, tolerating a 404)
 *   - bots this deploy UPDATED are restored to their prior roles/traits/TTL/description
 *
 * Deleting a created bot revokes that Machine ID identity — anything using its join token loses access.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildTeleportClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: BotRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    const site = await client.resolveSite()

    for (const entry of previousState) {
      if (!entry.existed) {
        const res = await client.request(
          'DELETE',
          `/v1/webapi/sites/${encodeURIComponent(site)}/machine-id/bot/${encodeURIComponent(entry.botName)}`,
        )
        if (res.status !== 404 && !res.ok) {
          throw new Error(`Failed to delete bot "${entry.botName}": ${teleportErrorMessage(res)}`)
        }
      } else {
        await updateBot(client, site, {
          botName: entry.botName,
          roles: entry.priorRoles ?? [],
          traits: entry.priorTraits ?? [],
          maxSessionTtl: entry.priorMaxSessionTtl ?? null,
          description: entry.priorDescription ?? null,
        })
      }
      reverted.push(entry.botName)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} bot(s): ${reverted.join(', ')}. Note: deleting a created bot revokes that Machine ID identity — anything using its join token loses access.`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} bot(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
