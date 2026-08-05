import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildCloudflareClient, cloudflareErrorMessage } from '../../lib/cloudflare'
import type { IdentityProviderRollbackEntry } from './deploy'
import type { LiveIdentityProvider } from './validate'

/**
 * Roll back Access identity providers using the state captured during deploy:
 *   - providers that were created are deleted (DELETE /access/identity_providers/{id})
 *   - providers that were updated are restored (PUT) to their prior name/type/config
 *
 * ⚠ SECURITY: Cloudflare redacts secret-bearing config fields (e.g.
 * `client_secret`) on read, so the `prior` config captured before an update
 * cannot include them. Restoring an UPDATED provider whose secret changed will
 * need that secret re-entered afterward — the same write-only limitation the
 * config_json field documents. A CREATED provider that is rolled back is simply
 * deleted, so this does not apply there.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildCloudflareClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: IdentityProviderRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.account('DELETE', `/access/identity_providers/${entry.id}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete identity provider "${entry.label}": ${cloudflareErrorMessage(res)}`)
          }
        }
      } else if (entry.id && entry.prior) {
        const res = await client.account('PUT', `/access/identity_providers/${entry.id}`, {
          body: restorePayload(entry.prior),
        })
        if (!res.ok) {
          throw new Error(`Failed to restore identity provider "${entry.label}": ${cloudflareErrorMessage(res)}`)
        }
      }
      reverted.push(entry.label)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} identity provider(s): ${reverted.join(', ')}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} provider(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}

/** Restore body from the prior live provider — name, type and whatever config Cloudflare returned. */
function restorePayload(prior: LiveIdentityProvider): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  if (prior.name !== undefined) body.name = prior.name
  if (prior.type !== undefined) body.type = prior.type
  if (prior.config !== undefined) body.config = prior.config
  if (prior.scim_config !== undefined) body.scim_config = prior.scim_config
  return body
}
