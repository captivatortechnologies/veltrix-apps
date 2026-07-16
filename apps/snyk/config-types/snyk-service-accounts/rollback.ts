import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildSnykClient, snykErrorMessage } from '../../lib/snyk'
import type { ServiceAccountRollbackEntry } from './deploy'

/**
 * Roll back service accounts using the state captured during deploy:
 *   - accounts this deploy created are deleted (DELETE by id; a 404 is tolerated
 *     because the account may already be gone)
 *   - accounts that were updated are restored (PATCH their prior name/role_id)
 * The generated token/secret is never involved in rollback.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildSnykClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built
  if (!client.hasOrg) {
    return { success: false, message: 'No Snyk organization id set — cannot roll back service accounts.' }
  }

  const previousState = (ctx.rollbackData as { previousState?: ServiceAccountRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.rest('DELETE', `${client.restOrgPath()}/service_accounts/${entry.id}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete service account "${entry.name}": ${snykErrorMessage(res)}`)
          }
        }
      } else if (entry.id && entry.prior) {
        const res = await client.rest('PATCH', `${client.restOrgPath()}/service_accounts/${entry.id}`, {
          body: {
            data: {
              id: entry.id,
              type: 'service_account',
              attributes: { name: entry.prior.name, role_id: entry.prior.role_id },
            },
          },
        })
        if (!res.ok) throw new Error(`Failed to restore service account "${entry.name}": ${snykErrorMessage(res)}`)
      }
      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} service account(s): ${reverted.join(', ') || 'none'}`,
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
