import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildS1Client, s1ErrorMessage } from '../../lib/s1'
import type { ExclusionRollbackEntry } from './deploy'

/**
 * Roll back exclusions using the state captured during deploy:
 *   - exclusions that were created are deleted (DELETE /exclusions)
 *   - exclusions that were updated are restored (PUT) to their prior body
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildS1Client(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built
  const sf = client.scopeFilter()
  if (sf.error || !sf.filter) return { success: false, message: sf.error ?? 'scope not configured' }
  const filter = sf.filter

  const previousState = (ctx.rollbackData as { previousState?: ExclusionRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.request('DELETE', '/exclusions', {
            body: { data: { ids: [entry.id], type: entry.type } },
          })
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete exclusion "${entry.label}": ${s1ErrorMessage(res)}`)
          }
        }
      } else if (entry.id && entry.prior) {
        const p = entry.prior
        const restore: Record<string, unknown> = {
          id: entry.id,
          type: p.type,
          value: p.value,
          osType: p.osType,
          source: p.source ?? 'user',
          description: p.description ?? '',
        }
        if (p.mode !== undefined) restore.mode = p.mode
        if (p.pathExclusionType !== undefined) restore.pathExclusionType = p.pathExclusionType
        const res = await client.request('PUT', '/exclusions', { body: { filter, data: restore } })
        if (!res.ok) {
          throw new Error(`Failed to restore exclusion "${entry.label}": ${s1ErrorMessage(res)}`)
        }
      }
      reverted.push(entry.label)
    }

    return { success: true, message: `Rolled back ${reverted.length} exclusion(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
