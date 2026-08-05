import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildS1Client, s1ErrorMessage } from '../../lib/s1'
import type { DeviceRuleRollbackEntry } from './deploy'

/**
 * Roll back Device Control rules using the state captured during deploy:
 *   - rules that were created are deleted (DELETE /device-control)
 *   - rules that were updated are restored (PUT) to their prior body
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

  const previousState = (ctx.rollbackData as { previousState?: DeviceRuleRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.request('DELETE', '/device-control', { body: { data: { ids: [entry.id] } } })
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete device control rule "${entry.label}": ${s1ErrorMessage(res)}`)
          }
        }
      } else if (entry.id && entry.prior) {
        const p = entry.prior
        const restore: Record<string, unknown> = {
          id: entry.id,
          ruleName: p.ruleName,
          interface: p.interface,
          action: p.action,
          accessPermission: p.accessPermission ?? 'Not-Applicable',
          deviceClass: p.deviceClass ?? '',
          vendorId: p.vendorId ?? '',
          productId: p.productId ?? '',
          uid: p.uid ?? '',
          bluetoothAddress: p.bluetoothAddress ?? '',
          status: p.status,
        }
        const res = await client.request('PUT', '/device-control', { body: { filter, data: restore } })
        if (!res.ok) {
          throw new Error(`Failed to restore device control rule "${entry.label}": ${s1ErrorMessage(res)}`)
        }
      }
      reverted.push(entry.label)
    }

    return { success: true, message: `Rolled back ${reverted.length} device control rule(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
