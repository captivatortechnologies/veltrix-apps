// =============================================================================
// Roll back a device-value deploy via the Defender API.
//
// Undo runs in reverse order: each recorded machine is PATCHed back to the value
// it carried before the deploy, via PATCH /api/machines/{id} { deviceValue }. A
// 404 (the device is gone) is tolerated. It only ever touches the devices the
// deploy recorded as changed.
// =============================================================================

import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildMdeClient, mdeErrorMessage } from '../../lib/mde'
import type { DeviceValueRollbackEntry } from './deploy'

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildMdeClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: DeviceValueRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []
  try {
    for (const entry of [...previousState].reverse()) {
      const res = await client.request('PATCH', `/machines/${entry.machineId}`, { body: { deviceValue: entry.previousValue } })
      if (res.status !== 404 && !res.ok) throw new Error(`Failed to restore device value on ${entry.label}: ${mdeErrorMessage(res)}`)
      reverted.push(entry.label)
    }
    return { success: true, message: `Rolled back ${reverted.length} device value(s)` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}
