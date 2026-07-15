import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildZscalerClient, zscalerErrorMessage } from '../../lib/zscaler'
import type { ServerRollbackEntry } from './deploy'

/**
 * Roll back ZPA servers using the state captured during deploy:
 *   - servers that were created are deleted (DELETE /server/{id})
 *   - servers that were updated are restored (PUT) to their prior body
 * ZPA changes are immediate, so no activation is needed. Deleting a server that
 * a server group still references will fail — reverse-order and the pipeline's
 * dependency ordering keep referrers gone first.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: ServerRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id != null) {
          const res = await client.zpa('DELETE', `/server/${entry.id}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete server "${entry.name}": ${zscalerErrorMessage(res)}`)
          }
        }
      } else if (entry.id != null && entry.prior) {
        const restore: Record<string, unknown> = {
          id: entry.id,
          name: entry.prior.name ?? entry.name,
          description: entry.prior.description ?? '',
          address: entry.prior.address ?? '',
          enabled: entry.prior.enabled ?? true,
        }
        const res = await client.zpa('PUT', `/server/${entry.id}`, { body: restore })
        if (!res.ok) {
          throw new Error(`Failed to restore server "${entry.name}": ${zscalerErrorMessage(res)}`)
        }
      }
      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} ZPA server(s): ${reverted.join(', ')}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} server(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
