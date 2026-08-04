import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildPPClient, ppErrorMessage } from '../../lib/proofpoint'
import { idpPath } from './deploy'
import type { IdpRollbackEntry } from './deploy'

/**
 * Roll back Identity Providers using the state captured during deploy:
 *   - IDPs that were created are deleted (DELETE .../idps/{id})
 *   - IDPs that were updated are restored (PUT) to their prior body
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildPPClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: IdpRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: true, message: 'Nothing to roll back — this deploy changed no Identity Providers.' }
  }

  const reverted: string[] = []
  const skipped: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (!entry.id) {
          // The create response did not carry an id we could parse — nothing to
          // delete by. Leave it in place rather than guessing.
          skipped.push(entry.name)
          continue
        }
        const res = await client.request('DELETE', idpPath(client, entry.id))
        if (res.status !== 404 && !res.ok) {
          throw new Error(`Failed to delete Identity Provider "${entry.name}": ${ppErrorMessage(res)}`)
        }
      } else if (entry.prior && entry.id) {
        const p = entry.prior
        const restore = {
          name: p.name ?? entry.name,
          is_active: p.is_active ?? true,
          description: p.description ?? '',
          icon_ref: p.icon_ref ?? '',
          idp_entity_id: p.idp_entity_id ?? '',
          idp_login_url: p.idp_login_url ?? '',
          idp_logout_url: p.idp_logout_url ?? '',
          idp_public_cert: p.idp_public_cert ?? '',
        }
        const res = await client.request('PUT', idpPath(client, entry.id), { body: restore })
        if (!res.ok) throw new Error(`Failed to restore Identity Provider "${entry.name}": ${ppErrorMessage(res)}`)
      }
      reverted.push(entry.name)
    }

    const skippedNote = skipped.length > 0 ? ` (skipped ${skipped.length} created IDP(s) with no captured id: ${skipped.join(', ')})` : ''
    return { success: true, message: `Rolled back ${reverted.length} Identity Provider(s): ${reverted.join(', ')}${skippedNote}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
