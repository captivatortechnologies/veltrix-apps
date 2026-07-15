import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildVaultClient, vaultErrorMessage } from '../../lib/vault'
import type { EntityRollbackEntry } from './deploy'

/**
 * Roll back identity entities using the state captured during deploy:
 *   - entities this deploy CREATED are deleted (DELETE /identity/entity/name/{name})
 *   - entities this deploy OVERWROTE are restored to their prior authored fields
 *     (POST /identity/entity/name/{name} with the captured policies/metadata/disabled)
 *
 * DELETING an entity is consequential: Vault revokes every token that was issued
 * to that entity, so any session authenticated as it is immediately invalidated.
 * Rollback therefore only ever deletes entities that DEPLOY ITSELF CREATED
 * (existed:false) — never a pre-existing one — and the result message says so.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildVaultClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: EntityRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []
  const deleted: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        // Deploy CREATED this entity — delete it. 404 means it is already gone,
        // which is the desired end state.
        const res = await client.request('DELETE', `/identity/entity/name/${entry.name}`)
        if (res.status !== 404 && !res.ok) {
          throw new Error(`Failed to delete identity entity "${entry.name}": ${vaultErrorMessage(res)}`)
        }
        deleted.push(entry.name)
      } else if (entry.prior) {
        // Deploy OVERWROTE this entity — restore its captured authored fields.
        const res = await client.request('POST', `/identity/entity/name/${entry.name}`, {
          body: {
            policies: entry.prior.policies,
            metadata: entry.prior.metadata,
            disabled: entry.prior.disabled,
          },
        })
        if (!res.ok) {
          throw new Error(`Failed to restore identity entity "${entry.name}": ${vaultErrorMessage(res)}`)
        }
      }

      reverted.push(entry.name)
    }

    const deleteNote = deleted.length
      ? ` Deleted ${deleted.length} newly-created entity(ies) (${deleted.join(', ')}) — this REVOKES every token issued to those entities.`
      : ''
    return {
      success: true,
      message: `Rolled back ${reverted.length} identity entity(ies): ${reverted.join(', ')}.${deleteNote}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} entity(ies): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
