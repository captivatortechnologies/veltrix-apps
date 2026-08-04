import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildJamfClient } from '../../lib/jamfApi'
import type { ProfileRollbackEntry } from './deploy'

const PROFILES_PATH = '/osxconfigurationprofiles'

/**
 * Roll back Jamf Pro macOS configuration profiles using the state captured
 * during deploy:
 *   - profiles that were created are deleted (DELETE /osxconfigurationprofiles/id/{id})
 *   - profiles that were updated are restored to their captured prior full
 *     XML, byte-for-byte (PUT /osxconfigurationprofiles/id/{id}) — including
 *     the opaque payload and every unmanaged section (self_service,
 *     category, site, uuid) exactly as it was.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildJamfClient(ctx.component, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: ProfileRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.classicRequest('DELETE', `${PROFILES_PATH}/id/${encodeURIComponent(entry.id)}`)
          if (res.error) throw new Error(`Failed to delete profile "${entry.label}": ${res.error}`)
        }
      } else if (entry.id && entry.priorXml) {
        const res = await client.classicRequest('PUT', `${PROFILES_PATH}/id/${encodeURIComponent(entry.id)}`, entry.priorXml)
        if (res.error) throw new Error(`Failed to restore profile "${entry.label}": ${res.error}`)
      }
      reverted.push(entry.label)
    }
    return {
      success: true,
      message: `Rolled back ${reverted.length} Jamf Pro macOS configuration profile(s): ${reverted.join(', ')}`,
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
