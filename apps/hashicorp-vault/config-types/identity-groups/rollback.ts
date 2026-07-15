import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildVaultClient, vaultErrorMessage } from '../../lib/vault'
import { INTERNAL_TYPE } from './validate'
import type { GroupRollbackEntry } from './deploy'

/**
 * Roll back identity groups using the state captured during deploy:
 *   - groups this deploy CREATED (existed:false) are deleted
 *     (DELETE /identity/group/name/{name})
 *   - groups this deploy UPDATED are restored to their prior authored state
 *     (POST /identity/group/name/{name} with the captured prior fields)
 *
 * A group's type is immutable, so restore never changes it — it re-posts the
 * prior policies, members (internal only) and metadata. Deleting a group removes
 * its policy attachments and (for internal groups) its explicit membership; the
 * member entities/groups themselves are NOT deleted.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildVaultClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: GroupRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []
  const deleted: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        // Deploy CREATED this group — delete it. 404 = already gone (desired).
        const res = await client.request('DELETE', `/identity/group/name/${encodeURIComponent(entry.name)}`)
        if (res.status !== 404 && !res.ok) {
          throw new Error(`Failed to delete identity group "${entry.name}": ${vaultErrorMessage(res)}`)
        }
        deleted.push(entry.name)
      } else if (entry.prior) {
        // Deploy UPDATED this group — restore its prior authored state. Type is
        // immutable so it is left as it was; member lists apply to internal only.
        const priorType = (entry.prior.type ?? entry.type).toLowerCase()
        const body: Record<string, unknown> = {
          type: priorType,
          policies: entry.prior.policies ?? [],
        }
        if (priorType === INTERNAL_TYPE) {
          body.member_entity_ids = entry.prior.member_entity_ids ?? []
          body.member_group_ids = entry.prior.member_group_ids ?? []
        }
        if (entry.prior.metadata !== undefined && entry.prior.metadata !== null) {
          body.metadata = entry.prior.metadata
        }

        const res = await client.request('POST', `/identity/group/name/${encodeURIComponent(entry.name)}`, { body })
        if (!res.ok) {
          throw new Error(`Failed to restore identity group "${entry.name}": ${vaultErrorMessage(res)}`)
        }
      }

      reverted.push(entry.name)
    }

    const deleteNote = deleted.length
      ? ` Deleted ${deleted.length} newly-created group(s) (${deleted.join(', ')}) — this removes their policy attachments and explicit membership (the member entities/groups themselves are not deleted).`
      : ''
    return {
      success: true,
      message: `Rolled back ${reverted.length} identity group(s): ${reverted.join(', ')}.${deleteNote}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} group(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
