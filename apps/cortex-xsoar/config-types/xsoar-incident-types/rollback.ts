import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildXsoarClient, xsoarErrorMessage } from '../../lib/xsoar'
import type { IncidentTypeRollbackEntry } from './deploy'

/**
 * Roll back incident types using the state captured during deploy:
 *   - types that were created are deleted (POST /incidenttype/delete { id })
 *   - types that were updated are restored (POST /incidenttype) to their prior body
 * A type already deleted out-of-band (404) is treated as success.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildXsoarClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: IncidentTypeRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.request('POST', '/incidenttype/delete', { body: { id: entry.id } })
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete incident type "${entry.name}": ${xsoarErrorMessage(res)}`)
          }
        }
      } else if (entry.prior) {
        const res = await client.request('POST', '/incidenttype', { body: entry.prior })
        if (!res.ok) {
          throw new Error(`Failed to restore incident type "${entry.name}": ${xsoarErrorMessage(res)}`)
        }
      }
      reverted.push(entry.name)
    }

    return { success: true, message: `Rolled back ${reverted.length} incident type(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
