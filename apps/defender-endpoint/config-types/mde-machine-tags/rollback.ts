// =============================================================================
// Roll back a device-tags deploy via the Defender API.
//
// Undo runs in reverse order: only tags this deploy ADDED (existed === false)
// are removed, via POST /api/machines/{id}/tags {Value, Action:'Remove'}; tags
// that were already present are left untouched. A 404 (the device is gone) is
// tolerated. It only ever touches the (device, tag) pairs the deploy recorded.
// =============================================================================

import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildMdeClient, mdeErrorMessage } from '../../lib/mde'
import type { MachineTagRollbackEntry } from './deploy'

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildMdeClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: MachineTagRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []
  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        const res = await client.request('POST', `/machines/${entry.machineId}/tags`, { body: { Value: entry.tag, Action: 'Remove' } })
        if (res.status !== 404 && !res.ok) throw new Error(`Failed to remove tag "${entry.tag}" from ${entry.label}: ${mdeErrorMessage(res)}`)
      }
      reverted.push(entry.label)
    }
    return { success: true, message: `Rolled back ${reverted.length} device tag(s)` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}
