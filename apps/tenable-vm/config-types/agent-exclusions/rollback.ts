import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildTenableClient, tenableErrorMessage } from '../../lib/tenable'
import type { AgentExclusionRollbackEntry } from './deploy'

/**
 * Roll back agent exclusions using the state captured during deploy:
 *   - exclusions this deploy created are deleted
 *     (DELETE /scanners/{scannerId}/agent-exclusions/{id})
 *   - exclusions this deploy updated are PUT back to their captured prior body
 *
 * Every call is scoped to the exclusion's cloud scanner via the scannerId
 * recorded on each rollback entry.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildTenableClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: AgentExclusionRollbackEntry[] })
    ?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      const base = `/scanners/${entry.scannerId}/agent-exclusions`
      if (!entry.existed) {
        // Deploy created this exclusion — remove it. 404 means it was never
        // created (or already removed), which is the desired end state.
        if (entry.id !== undefined) {
          const res = await client.request('DELETE', `${base}/${entry.id}`)
          if (!res.ok && res.status !== 404) {
            throw new Error(`Failed to delete agent exclusion "${entry.name}": ${tenableErrorMessage(res)}`)
          }
        }
      } else if (entry.id !== undefined && entry.prior) {
        // Deploy updated this exclusion — restore the captured prior body.
        const restore: Record<string, unknown> = {}
        if (entry.prior.name !== undefined) restore.name = entry.prior.name
        if (entry.prior.members !== undefined) restore.members = entry.prior.members
        if (entry.prior.description !== undefined) restore.description = entry.prior.description
        if (entry.prior.schedule !== undefined) restore.schedule = entry.prior.schedule ?? { enabled: false }

        const res = await client.request('PUT', `${base}/${entry.id}`, { body: restore })
        if (!res.ok) {
          throw new Error(`Failed to restore agent exclusion "${entry.name}": ${tenableErrorMessage(res)}`)
        }
      }

      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} agent exclusion(s): ${reverted.join(', ')}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} agent exclusion(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
