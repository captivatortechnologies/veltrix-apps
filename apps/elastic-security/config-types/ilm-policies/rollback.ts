import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildElasticClient, elasticErrorMessage } from '../../lib/elastic'
import type { IlmPolicyRollbackEntry } from './deploy'

/**
 * Roll back ILM policies using the state captured during deploy:
 *   - policies that were CREATED are deleted (DELETE /_ilm/policy/{name});
 *     a 404 means it is already gone, which is the desired end state.
 *   - policies that were UPDATED are restored (PUT) to their prior `.policy`.
 *
 * DELETE /_ilm/policy/{name} FAILS if the policy is still referenced by an index
 * or an index/component template (ES returns 4xx) — that error is surfaced
 * rather than swallowed, so an operator can detach the policy and retry.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildElasticClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: IlmPolicyRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        // Deploy created this policy — remove it. A referenced policy cannot be
        // deleted; ES returns a non-404 error which we surface.
        const res = await client.elasticsearch('DELETE', `/_ilm/policy/${encodeURIComponent(entry.name)}`)
        if (res.status !== 404 && !res.ok) {
          throw new Error(
            `Failed to delete ILM policy "${entry.name}" (it may still be referenced by an index or template): ${elasticErrorMessage(res)}`,
          )
        }
      } else if (entry.priorPolicy) {
        // Deploy replaced this policy — restore the captured prior body (upsert).
        const res = await client.elasticsearch('PUT', `/_ilm/policy/${encodeURIComponent(entry.name)}`, {
          body: { policy: entry.priorPolicy },
        })
        if (!res.ok) {
          throw new Error(`Failed to restore ILM policy "${entry.name}": ${elasticErrorMessage(res)}`)
        }
      }

      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} ILM policy(ies): ${reverted.join(', ')}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} policy(ies): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
