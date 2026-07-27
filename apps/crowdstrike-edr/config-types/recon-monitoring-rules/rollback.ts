import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient, falconFailure } from '../../lib/falcon'
import { deleteEntity, findEntityByIdentity, updateEntity } from '../../lib/entityAdapter'
import {
  RECON_RULE_ENDPOINTS,
  deleteAction,
  updateAction,
  type ReconRuleRollbackEntry,
} from './deploy'

/**
 * Roll back Recon monitoring rules using the state captured during deploy:
 *   - rules that were created are deleted (which cascades their actions and, with
 *     notificationsDeletionRequested, their generated notifications)
 *   - rules that were updated are patched back to their prior mutable values, the
 *     actions this deploy created are removed, and the actions this deploy updated
 *     are restored to their prior values
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: ReconRuleRollbackEntry[] })
    ?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        // Deploy created this rule — remove it (cascades its actions). Re-resolve
        // by identity so a concurrent delete is a no-op instead of a hard error.
        const live = await findEntityByIdentity(client, RECON_RULE_ENDPOINTS, entry.name)
        if (live?.id) {
          await deleteEntity(client, RECON_RULE_ENDPOINTS, live.id, {
            notificationsDeletionRequested: 'true',
          })
        }
      } else if (entry.id && entry.prior) {
        // Deploy updated this rule — remove the actions it created first.
        for (const actionId of entry.createdActionIds ?? []) {
          const res = await deleteAction(client, actionId)
          const failure = res.status === 404 ? null : falconFailure(res)
          if (failure) {
            throw new Error(`Failed to delete action ${actionId} for rule "${entry.name}": ${failure}`)
          }
        }

        // Restore the actions it updated to their captured prior values.
        for (const prior of entry.updatedActions ?? []) {
          await updateAction(client, {
            id: prior.id,
            frequency: prior.frequency,
            recipients: prior.recipients,
            content_format: prior.content_format,
          })
        }

        // Restore the rule's prior mutable fields (topic is immutable — untouched).
        const prior = entry.prior
        const restore: Record<string, unknown> = { id: entry.id }
        if (prior.name !== undefined) restore.name = prior.name
        if (prior.filter !== undefined) restore.filter = prior.filter
        if (prior.priority !== undefined) restore.priority = prior.priority
        if (prior.permissions !== undefined) restore.permissions = prior.permissions
        if (prior.breach_monitoring_enabled !== undefined) {
          restore.breach_monitoring_enabled = prior.breach_monitoring_enabled
        }
        if (prior.substring_matching_enabled !== undefined) {
          restore.substring_matching_enabled = prior.substring_matching_enabled
        }
        await updateEntity(client, RECON_RULE_ENDPOINTS, restore)
      }

      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} Recon monitoring rule(s): ${reverted.join(', ')}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} rule(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
