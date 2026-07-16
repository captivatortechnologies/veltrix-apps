import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildInsightVMClient, insightVMErrorMessage } from '../../lib/insightvm'
import type { PoolRollbackEntry } from './deploy'

/**
 * Roll back scan engine pools using the state captured during deploy:
 *   - pools that were created are deleted (DELETE /scan_engine_pools/{id})
 *   - pools that were updated are restored (PUT) to their prior name + engine ids
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildInsightVMClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: PoolRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id != null) {
          const res = await client.request('DELETE', `/scan_engine_pools/${entry.id}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete scan engine pool "${entry.label}": ${insightVMErrorMessage(res)}`)
          }
        }
      } else if (entry.id != null && entry.prior) {
        const p = entry.prior
        const restore: Record<string, unknown> = {
          name: p.name,
          engines: Array.isArray(p.engines) ? p.engines : [],
        }
        const res = await client.request('PUT', `/scan_engine_pools/${entry.id}`, { body: restore })
        if (!res.ok) throw new Error(`Failed to restore scan engine pool "${entry.label}": ${insightVMErrorMessage(res)}`)
      }
      reverted.push(entry.label)
    }

    return { success: true, message: `Rolled back ${reverted.length} scan engine pool(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
