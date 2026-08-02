import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildJamfClient } from '../../lib/jamfApi'
import type { PolicyRollbackEntry } from './deploy'

const POLICIES_PATH = '/policies'

/**
 * Roll back Jamf Pro policies using the state captured during deploy:
 *   - policies that were created are deleted (DELETE /policies/id/{id})
 *   - policies that were updated are restored to their captured prior full
 *     XML, byte-for-byte (PUT /policies/id/{id}) — including every unmanaged
 *     section (self_service, maintenance, …) exactly as it was, since the
 *     captured document is the untouched pre-merge original.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildJamfClient(ctx.component, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: PolicyRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.classicRequest('DELETE', `${POLICIES_PATH}/id/${encodeURIComponent(entry.id)}`)
          if (res.error) throw new Error(`Failed to delete policy "${entry.label}": ${res.error}`)
        }
      } else if (entry.id && entry.priorXml) {
        const res = await client.classicRequest('PUT', `${POLICIES_PATH}/id/${encodeURIComponent(entry.id)}`, entry.priorXml)
        if (res.error) throw new Error(`Failed to restore policy "${entry.label}": ${res.error}`)
      }
      reverted.push(entry.label)
    }

    return { success: true, message: `Rolled back ${reverted.length} Jamf Pro polic${reverted.length === 1 ? 'y' : 'ies'}: ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
