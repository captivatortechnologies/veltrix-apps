import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildTinesClient, tinesErrorMessage } from '../../lib/tinesApi'
import type { GlobalResourceRollbackEntry } from './deploy'

/**
 * Undo a Global Resources deploy from rollbackData.previousState (written by
 * deploy()), in reverse order:
 *   - a resource that was CREATED is deleted (DELETE /api/v1/global_resources/{id})
 *   - a resource that was UPDATED is restored (PUT) to its prior value/settings
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildTinesClient(ctx.component?.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: GlobalResourceRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: true, message: 'Nothing to roll back.' }
  }

  const reverted: string[] = []
  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.request('DELETE', `/global_resources/${entry.id}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete Global Resource "${entry.name}": ${tinesErrorMessage(res)}`)
          }
        }
      } else if (entry.id && entry.prior) {
        const body: Record<string, unknown> = {
          name: String(entry.prior.name ?? entry.name),
          value: entry.prior.value,
          read_access: entry.prior.read_access ?? 'TEAM',
        }
        if (entry.prior.description) body.description = entry.prior.description
        if (entry.prior.folder_id) body.folder_id = entry.prior.folder_id
        if (entry.prior.shared_team_slugs) body.shared_team_slugs = entry.prior.shared_team_slugs
        const res = await client.request('PUT', `/global_resources/${entry.id}`, { body })
        if (!res.ok) throw new Error(`Failed to restore Global Resource "${entry.name}": ${tinesErrorMessage(res)}`)
      }
      reverted.push(entry.name)
    }

    return { success: true, message: `Rolled back ${reverted.length} Global Resource(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
