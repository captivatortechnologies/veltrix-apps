import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildCatoClient, responseError } from '../../lib/cato'
import { DELETE_GLOBAL_IP_RANGE_BULK, UPDATE_GLOBAL_IP_RANGE_BULK } from './_shared'
import { buildNetworkRangeBody } from './validate'
import type { NetworkRangeRollbackEntry } from './deploy'

/**
 * Roll back Network Ranges using the state captured during deploy:
 *   - created ranges are deleted (deleteGlobalIpRangeBulk - ref by id)
 *   - updated ranges are restored to their previous canvas spec
 *     (ctx.previousConfig, captured at deploy time - never a live re-read)
 * No publish step - Global IP Ranges apply immediately.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildCatoClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client, accountId } = built

  const previousState = (ctx.rollbackData as { previousState?: NetworkRangeRollbackEntry[] } | null)?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: true, message: 'Nothing to roll back.' }
  }

  const toDelete = previousState.filter((e) => !e.existed && e.id)
  const toRestore = previousState.filter((e) => e.existed && e.id && e.priorSpec)
  const skipped = previousState.filter((e) => e.existed && (!e.id || !e.priorSpec))

  try {
    if (toRestore.length > 0) {
      const res = await client.graphql(UPDATE_GLOBAL_IP_RANGE_BULK, {
        accountId,
        input: toRestore.map((e) => ({ ...buildNetworkRangeBody(e.priorSpec!), id: e.id })),
      })
      const err = responseError(res)
      if (err) throw new Error(`Failed to restore network range(s): ${err}`)
    }

    if (toDelete.length > 0) {
      const res = await client.graphql(DELETE_GLOBAL_IP_RANGE_BULK, { accountId, input: toDelete.map((e) => ({ by: 'ID', input: e.id })) })
      const err = responseError(res)
      if (err) throw new Error(`Failed to delete network range(s): ${err}`)
    }

    const skippedNote = skipped.length > 0 ? ` (${skipped.length} left unchanged - no prior canvas version captured: ${skipped.map((e) => e.name).join(', ')})` : ''
    return {
      success: true,
      message: `Rolled back Network Range(s): ${toRestore.length} restored, ${toDelete.length} deleted${skippedNote}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
