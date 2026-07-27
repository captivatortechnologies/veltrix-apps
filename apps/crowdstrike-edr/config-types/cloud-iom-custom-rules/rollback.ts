import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient } from '../../lib/falcon'
import { deleteEntity, findEntityByIdentity, updateEntity } from '../../lib/entityAdapter'
import { CLOUD_IOM_RULE_ENDPOINTS, type CloudIomRuleRollbackEntry } from './deploy'

/**
 * Roll back IOM custom rules using the state captured during deploy:
 *   - rules that were created are deleted
 *   - rules that were updated are patched back to their prior values
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: CloudIomRuleRollbackEntry[] })
    ?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        // Deploy created this rule — remove it. Re-resolve by identity so a
        // concurrent delete makes this a no-op instead of a hard error.
        const live = await findEntityByIdentity(client, CLOUD_IOM_RULE_ENDPOINTS, entry.name)
        if (live?.id) {
          await deleteEntity(client, CLOUD_IOM_RULE_ENDPOINTS, live.id)
        }
      } else if (entry.id && entry.prior) {
        // Deploy updated this rule — restore the captured prior values. Controls
        // are always re-sent so a compliance pair the deployment added is removed.
        const prior = entry.prior
        const restore: Record<string, unknown> = { id: entry.id, name: entry.name }
        if (prior.description !== undefined) restore.description = prior.description
        if (prior.cloud_provider !== undefined) restore.cloud_provider = prior.cloud_provider
        if (prior.resource_type !== undefined) restore.resource_type = prior.resource_type
        if (prior.severity !== undefined) restore.severity = prior.severity
        if (prior.logic !== undefined) restore.logic = prior.logic
        if (prior.parent_rule_id !== undefined) restore.parent_rule_id = prior.parent_rule_id
        restore.controls = prior.controls ?? []

        await updateEntity(client, CLOUD_IOM_RULE_ENDPOINTS, restore)
      }

      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} IOM custom rule(s): ${reverted.join(', ')}`,
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
