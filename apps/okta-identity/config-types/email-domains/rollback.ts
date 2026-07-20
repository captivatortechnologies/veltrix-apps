import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient, oktaErrorMessage } from '../../lib/okta'
import { type EmailDomainRollbackEntry } from './deploy'

/**
 * Roll back custom email domains using the state captured during deploy:
 *   - domains this deploy CREATED are deleted. A 404 means it is already gone
 *     (tolerated). A 400 (ErrorEmailDomainInUse) means the domain is still bound
 *     to a mail-provider/brand configuration — that is surfaced clearly and the
 *     delete is retried once (in case the operator has since detached it).
 *   - domains this deploy UPDATED are PUT back to their captured prior sender
 *     fields (displayName/userName). domain, brandId and validationSubdomain are
 *     immutable, so only the sender fields ever need restoring.
 *
 * Rollback is keyed on the email-domain id Okta returned, never on the domain.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: EmailDomainRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        // Deploy created this domain — remove it. A 404 = already gone (fine). A
        // 400 = ErrorEmailDomainInUse: still attached to a mail-provider/brand
        // config; surface that clearly and retry the delete once.
        if (entry.id) {
          const del = await client.request('DELETE', `/email-domains/${entry.id}`)
          if (del.status === 400) {
            const retry = await client.request('DELETE', `/email-domains/${entry.id}`)
            if (!retry.ok && retry.status !== 404) {
              throw new Error(
                `Failed to delete email domain "${entry.domain}": ${oktaErrorMessage(retry)}. Okta will not delete an email domain that is still in use by a mail-provider/brand configuration — detach it from that configuration first, then retry the rollback.`,
              )
            }
          } else if (!del.ok && del.status !== 404) {
            throw new Error(`Failed to delete email domain "${entry.domain}": ${oktaErrorMessage(del)}`)
          }
        }
      } else if (entry.id && entry.prior) {
        // Deploy updated this domain — restore its captured prior sender fields.
        const res = await client.request('PUT', `/email-domains/${entry.id}`, { body: entry.prior })
        if (!res.ok) {
          throw new Error(`Failed to restore email domain "${entry.domain}": ${oktaErrorMessage(res)}`)
        }
      }

      reverted.push(entry.domain)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} email domain(s): ${reverted.join(', ')}. Domains created by the deployment were deleted (a domain still in use by a mail-provider/brand config must be detached first).`,
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
