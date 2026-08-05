import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildSnykClient, snykErrorMessage } from '../../lib/snyk'
import type { PolicyRollbackEntry } from './deploy'

/**
 * Roll back org-level ignore policies using the state captured during deploy:
 *   - policies this deploy created are deleted (DELETE by id; a 404 is
 *     tolerated because the policy may already be gone)
 *   - policies that were updated are restored to their prior name/conditions/action
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildSnykClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built
  if (!client.hasOrg) {
    return { success: false, message: 'No Snyk organization id set — cannot roll back ignore policies.' }
  }

  const previousState = (ctx.rollbackData as { previousState?: PolicyRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.rest('DELETE', `${client.restOrgPath()}/policies/${entry.id}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete ignore policy "${entry.name}": ${snykErrorMessage(res)}`)
          }
        }
      } else if (entry.id && entry.prior) {
        const res = await client.rest('PATCH', `${client.restOrgPath()}/policies/${entry.id}`, {
          body: {
            data: {
              id: entry.id,
              type: 'policy',
              attributes: {
                name: entry.prior.name,
                conditions_group: entry.prior.conditionsGroup,
                action: entry.prior.action,
              },
            },
          },
        })
        if (!res.ok) throw new Error(`Failed to restore ignore policy "${entry.name}": ${snykErrorMessage(res)}`)
      }
      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} ignore polic${reverted.length === 1 ? 'y' : 'ies'}: ${reverted.join(', ') || 'none'}`,
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
