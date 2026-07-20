import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient, oktaErrorMessage } from '../../lib/okta'
import { buildCustomUpdateBody, schemaLabel, schemaPath, type ProfileSchemaRollbackEntry } from './deploy'

/**
 * Roll back profile-schema changes using the state captured during deploy. For each
 * schema this deploy touched, the managed attributes are POSTed back to their
 * captured PRIOR state:
 *   - an attribute that existed before is restored to its prior definition.
 *   - an attribute this deploy ADDED (prior state null) is removed again (POSTing
 *     it as `null`).
 * Because the update is a partial patch, only the managed attribute names are
 * touched — unmanaged custom attributes and all base attributes are left untouched.
 *
 * The schema object is never created or deleted; rollback is always an update.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: ProfileSchemaRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    // Undo in reverse so later changes are reverted before earlier ones.
    for (const entry of [...previousState].reverse()) {
      const label = schemaLabel(entry.schemaType, entry.userTypeId)

      const res = await client.request('POST', schemaPath(entry.schemaType, entry.userTypeId), {
        body: buildCustomUpdateBody(entry.priorAttributes),
      })
      if (!res.ok) {
        throw new Error(`Failed to restore ${label} custom attributes: ${oktaErrorMessage(res)}`)
      }

      reverted.push(label)
    }

    return {
      success: true,
      message: `Rolled back custom profile attributes on ${reverted.length} schema(s): ${reverted.join(', ')}.`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} schema(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
