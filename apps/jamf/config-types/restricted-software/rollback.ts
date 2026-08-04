import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildJamfClient } from '../../lib/jamfApi'
import type { RestrictedSoftwareRollbackEntry } from './deploy'

const RESTRICTED_SOFTWARE_PATH = '/restrictedsoftware'

/**
 * Roll back Jamf Pro restricted software records using the state captured
 * during deploy:
 *   - records that were created are deleted (DELETE /restrictedsoftware/id/{id})
 *   - records that were updated are restored to their captured prior full
 *     XML, byte-for-byte (PUT /restrictedsoftware/id/{id}).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildJamfClient(ctx.component, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: RestrictedSoftwareRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.classicRequest('DELETE', `${RESTRICTED_SOFTWARE_PATH}/id/${encodeURIComponent(entry.id)}`)
          if (res.error) throw new Error(`Failed to delete restricted software "${entry.label}": ${res.error}`)
        }
      } else if (entry.id && entry.priorXml) {
        const res = await client.classicRequest('PUT', `${RESTRICTED_SOFTWARE_PATH}/id/${encodeURIComponent(entry.id)}`, entry.priorXml)
        if (res.error) throw new Error(`Failed to restore restricted software "${entry.label}": ${res.error}`)
      }
      reverted.push(entry.label)
    }
    return {
      success: true,
      message: `Rolled back ${reverted.length} Jamf Pro restricted software record(s): ${reverted.join(', ')}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
