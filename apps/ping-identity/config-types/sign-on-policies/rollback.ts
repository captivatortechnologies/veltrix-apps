import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildPingOneClient, pingOneErrorMessage } from '../../lib/pingOne'
import type { PolicyRollbackEntry } from './deploy'

/**
 * Roll back sign-on policies (and their reconciled actions) using the state
 * captured during deploy:
 *   - a policy this deploy CREATED is deleted - its created actions are
 *     deleted FIRST (defensive; deleting the policy would cascade-delete them
 *     too, but this keeps the dependency order explicit), then the policy
 *     itself. PingOne refuses to delete the environment's current default
 *     policy - that error is surfaced as-is so the operator can make another
 *     policy the default first, then retry.
 *   - a policy this deploy UPDATED is restored (PUT) to its prior body FIRST
 *     (actions require the parent to exist), then its actions are
 *     restored/deleted: an action this deploy CREATED is deleted, one it
 *     UPDATED is restored (PUT) to its prior body.
 * Deletes tolerate a 404 (already gone is the desired end state).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildPingOneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: PolicyRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    // Undo in reverse so later changes are reverted before earlier ones.
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        // Deploy created this policy - remove its created actions first, then
        // the policy itself.
        if (entry.id) {
          for (const action of [...entry.actionRollback].reverse()) {
            if (!action.existed && action.id) {
              const res = await client.request('DELETE', `/signOnPolicies/${entry.id}/actions/${action.id}`)
              if (res.status !== 404 && !res.ok) {
                throw new Error(
                  `Failed to delete action (priority ${action.priority}) on sign-on policy "${entry.name}": ${pingOneErrorMessage(res)}`,
                )
              }
            }
          }

          const res = await client.request('DELETE', `/signOnPolicies/${entry.id}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(
              `Failed to delete sign-on policy "${entry.name}": ${pingOneErrorMessage(res)}. If this is the ` +
                'environment\'s current default policy, PingOne refuses to delete it - make another policy the ' +
                'default first, then retry the rollback.',
            )
          }
        }
      } else if (entry.id) {
        // Deploy updated this policy - restore its prior body FIRST (actions
        // require the parent to already exist), then its actions.
        if (entry.prior) {
          const res = await client.request('PUT', `/signOnPolicies/${entry.id}`, { body: entry.prior })
          if (!res.ok) {
            throw new Error(`Failed to restore sign-on policy "${entry.name}": ${pingOneErrorMessage(res)}`)
          }
        }

        for (const action of [...entry.actionRollback].reverse()) {
          if (!action.existed) {
            if (action.id) {
              const res = await client.request('DELETE', `/signOnPolicies/${entry.id}/actions/${action.id}`)
              if (res.status !== 404 && !res.ok) {
                throw new Error(
                  `Failed to delete action (priority ${action.priority}) on sign-on policy "${entry.name}": ${pingOneErrorMessage(res)}`,
                )
              }
            }
          } else if (action.prior && action.id) {
            const res = await client.request('PUT', `/signOnPolicies/${entry.id}/actions/${action.id}`, {
              body: action.prior,
            })
            if (!res.ok) {
              throw new Error(
                `Failed to restore action (priority ${action.priority}) on sign-on policy "${entry.name}": ${pingOneErrorMessage(res)}`,
              )
            }
          }
        }
      }

      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} sign-on policy(ies): ${reverted.join(', ')}`,
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
