import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient, oktaErrorMessage } from '../../lib/okta'
import {
  bindingPath,
  listBindingMembers,
  reconcileBindingMembers,
  type BindingRollbackEntry,
} from './deploy'

/**
 * Roll back resource-set bindings using the state captured during deploy:
 *   - bindings this deploy CREATED (existed: false) are DELETEd. Okta may have
 *     already removed a binding whose last member was unassigned, so a 404 is
 *     tolerated (already gone is the desired end state).
 *   - bindings this deploy UPDATED (existed: true) have their membership reconciled
 *     back to the captured prior members via the members sub-resource.
 *
 * Rollback is keyed on the (resourceSet, role) pair captured with each entry — the
 * path fully identifies the binding, so no list/match is needed.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: BindingRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    // Undo in reverse so later changes are reverted before earlier ones.
    for (const entry of [...previousState].reverse()) {
      const label = `${entry.resourceSet}:${entry.role}`

      if (!entry.existed) {
        // Deploy created this binding — remove it entirely.
        const del = await client.request('DELETE', bindingPath(entry.resourceSet, entry.role))
        if (!del.ok && del.status !== 404) {
          throw new Error(`Failed to delete binding "${label}": ${oktaErrorMessage(del)}`)
        }
      } else {
        // Deploy updated this binding — reconcile its membership back to the
        // captured prior members. Add-before-remove keeps the count above zero so
        // Okta does not delete the binding mid-reconcile.
        const current = await listBindingMembers(client, entry.resourceSet, entry.role)
        await reconcileBindingMembers(
          client,
          entry.resourceSet,
          entry.role,
          entry.priorMembers ?? [],
          current,
        )
      }

      reverted.push(label)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} resource-set binding(s): ${reverted.join(', ')}.`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} binding(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
