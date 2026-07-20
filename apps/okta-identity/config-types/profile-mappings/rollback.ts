import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient, oktaErrorMessage } from '../../lib/okta'
import { buildMappingUpdateBody, mappingLabel, mappingPath, type ProfileMappingRollbackEntry } from './deploy'

/**
 * Roll back profile-mapping changes using the state captured during deploy. For each
 * mapping this deploy touched, the managed property mappings are POSTed back to their
 * captured PRIOR state:
 *   - a property mapping that existed before is restored to its prior
 *     `{ expression, pushStatus }`.
 *   - a property mapping this deploy ADDED (prior state `{ expression: null,
 *     pushStatus: null }`) is removed again.
 * Because the update is a MERGE, only the managed property names are touched —
 * unmanaged property mappings on the same mapping are left untouched.
 *
 * The mapping object is never created or deleted; rollback is always an update.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: ProfileMappingRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    // Undo in reverse so later changes are reverted before earlier ones.
    for (const entry of [...previousState].reverse()) {
      const label = mappingLabel(entry.sourceId, entry.targetId)

      const res = await client.request('POST', mappingPath(entry.mappingId), {
        body: buildMappingUpdateBody(entry.priorProperties),
      })
      if (!res.ok) {
        throw new Error(`Failed to restore property mappings for ${label}: ${oktaErrorMessage(res)}`)
      }

      reverted.push(label)
    }

    return {
      success: true,
      message: `Rolled back property mappings on ${reverted.length} mapping(s): ${reverted.join(', ')}.`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} mapping(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
