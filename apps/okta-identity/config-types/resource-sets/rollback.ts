import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient, oktaErrorMessage } from '../../lib/okta'
import { listResourceMemberships, reconcileResources, type ResourceSetRollbackEntry } from './deploy'

/**
 * Roll back resource sets using the state captured during deploy:
 *   - sets this deploy CREATED are deleted. Okta may refuse a delete while the
 *     set is still bound to a custom role — that error is surfaced clearly so the
 *     operator can remove the binding first.
 *   - sets this deploy UPDATED are PUT back to their captured prior
 *     label/description, and their resource membership is reconciled back to the
 *     captured prior resources via the /resources sub-resource.
 *
 * Rollback is keyed on the resource-set id Okta returned, never on the label.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: ResourceSetRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    // Undo in reverse so later changes are reverted before earlier ones.
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        // Deploy created this set — remove it.
        if (entry.id) {
          const del = await client.request('DELETE', `/iam/resource-sets/${entry.id}`)
          if (!del.ok && del.status !== 404) {
            throw new Error(
              `Failed to delete resource set "${entry.label}": ${oktaErrorMessage(del)}. Okta may refuse to delete a resource set that is still bound to a custom role — remove the binding first, then retry the rollback.`,
            )
          }
        }
      } else if (entry.id && entry.prior) {
        // Deploy updated this set — restore prior label/description, then reconcile
        // resources back to the captured prior set.
        const res = await client.request('PUT', `/iam/resource-sets/${entry.id}`, {
          body: { label: entry.prior.label, description: entry.prior.description },
        })
        if (!res.ok) {
          throw new Error(`Failed to restore resource set "${entry.label}": ${oktaErrorMessage(res)}`)
        }
        const current = await listResourceMemberships(client, entry.id)
        await reconcileResources(client, entry.id, entry.priorResources ?? [], current)
      }

      reverted.push(entry.label)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} resource set(s): ${reverted.join(', ')}.`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} set(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
