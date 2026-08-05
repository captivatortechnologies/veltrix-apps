import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildPingOneClient, pingOneErrorMessage } from '../../lib/pingOne'
import type { PasswordPolicyRollbackEntry } from './deploy'

/**
 * Roll back password policies using the state captured during deploy:
 *   - policies this deploy CREATED are deleted (DELETE /passwordPolicies/{id}).
 *     PingOne refuses to delete a policy still assigned to a population that
 *     has users - that error is surfaced verbatim (never swallowed) so the
 *     operator knows exactly which population to reassign first.
 *   - policies this deploy UPDATED are PUT back to their captured prior body.
 *
 * Rollback is keyed on the policy id PingOne returned, never on the name.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildPingOneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: PasswordPolicyRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.request('DELETE', `/passwordPolicies/${entry.id}`)
          if (!res.ok && res.status !== 404) {
            throw new Error(`Failed to delete password policy "${entry.name}": ${pingOneErrorMessage(res)}`)
          }
        }
      } else if (entry.id && entry.prior) {
        const res = await client.request('PUT', `/passwordPolicies/${entry.id}`, { body: entry.prior })
        if (!res.ok) {
          throw new Error(`Failed to restore password policy "${entry.name}": ${pingOneErrorMessage(res)}`)
        }
      }

      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} password polic${reverted.length === 1 ? 'y' : 'ies'}: ${reverted.join(', ')}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} polic${previousState.length === 1 ? 'y' : 'ies'}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
