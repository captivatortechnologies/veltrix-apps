import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient, oktaErrorMessage } from '../../lib/okta'
import { type CustomDomainRollbackEntry } from './deploy'
import { buildBrandBody } from './validate'

/**
 * Roll back custom domains using the state captured during deploy:
 *   - domains this deploy CREATED are deleted. A 404 means it is already gone
 *     (tolerated).
 *   - domains this deploy REBOUND to a different brand are rebound back to
 *     their captured prior brandId via PUT /domains/{id}.
 *
 * LIMITATIONS (surfaced in the result message):
 *   - A domain's certificate material (certificate/certificateChain/privateKey)
 *     is WRITE-ONLY — Okta never returns it, so a certificate this deploy set
 *     or rotated cannot be restored to its previous value.
 *   - A domain that had NO brand bound before this deploy cannot be restored to
 *     "unbound" — Okta's replace-brand endpoint requires a brandId and has no
 *     "clear the brand" operation.
 *
 * Rollback is keyed on the domain id Okta returned, never on the domain string.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: CustomDomainRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []
  let skippedUnbind = false

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        // Deploy created this domain — remove it. A 404 = already gone (fine).
        if (entry.id) {
          const del = await client.request('DELETE', `/domains/${entry.id}`)
          if (!del.ok && del.status !== 404) {
            throw new Error(`Failed to delete custom domain "${entry.domain}": ${oktaErrorMessage(del)}`)
          }
        }
      } else if (entry.id) {
        if (entry.priorBrandId) {
          const res = await client.request('PUT', `/domains/${entry.id}`, {
            body: buildBrandBody(entry.priorBrandId),
          })
          if (!res.ok) {
            throw new Error(`Failed to restore brand for custom domain "${entry.domain}": ${oktaErrorMessage(res)}`)
          }
        } else {
          // Had no brand bound before this deploy — Okta has no "unbind" API,
          // so a brand this deploy bound cannot be cleared on rollback.
          skippedUnbind = true
        }
      }

      reverted.push(entry.domain)
    }

    const unbindNote = skippedUnbind
      ? " A domain that had no brand bound before this deploy could not be un-bound on rollback — Okta has no API to clear a domain's brand."
      : ''

    return {
      success: true,
      message: `Rolled back ${reverted.length} custom domain(s): ${reverted.join(', ')}. Domains created by the deployment were deleted; rebound domains had their prior brand restored. Certificate material is write-only and could not be restored to any previous value.${unbindNote}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} domain(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
