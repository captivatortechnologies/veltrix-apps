import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildInsightVMClient, insightVMErrorMessage } from '../../lib/insightvm'
import type { TagRollbackEntry } from './deploy'

/**
 * Roll back tags using the state captured during deploy:
 *   - tags that were created are deleted (DELETE /tags/{id})
 *   - tags that were updated are restored (PUT) to their prior body
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildInsightVMClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: TagRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id != null) {
          const res = await client.request('DELETE', `/tags/${entry.id}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete tag "${entry.label}": ${insightVMErrorMessage(res)}`)
          }
        }
      } else if (entry.id != null && entry.prior) {
        const p = entry.prior
        const restore: Record<string, unknown> = { name: p.name, type: p.type }
        if (p.color !== undefined) restore.color = p.color
        if (p.riskModifier !== undefined) restore.riskModifier = p.riskModifier
        if (p.searchCriteria !== undefined) restore.searchCriteria = p.searchCriteria
        const res = await client.request('PUT', `/tags/${entry.id}`, { body: restore })
        if (!res.ok) throw new Error(`Failed to restore tag "${entry.label}": ${insightVMErrorMessage(res)}`)
      }
      reverted.push(entry.label)
    }

    return { success: true, message: `Rolled back ${reverted.length} tag(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
