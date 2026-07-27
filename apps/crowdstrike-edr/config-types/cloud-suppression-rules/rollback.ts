import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient } from '../../lib/falcon'
import { deleteEntity, updateEntity } from '../../lib/entityAdapter'
import {
  SUPPRESSION_ENDPOINTS,
  findSuppressionRule,
  type SuppressionRollbackEntry,
} from './deploy'

/**
 * Roll back suppression rules using the state captured during deploy:
 *   - rules that were created are deleted
 *   - rules that were updated are patched back to their prior values
 * Created rules are re-resolved by name before deletion so a concurrent delete
 * becomes a no-op rather than a hard error.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: SuppressionRollbackEntry[] })
    ?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        // Deploy created this rule — remove it.
        const live = await findSuppressionRule(client, entry.name)
        if (live?.id) {
          await deleteEntity(client, SUPPRESSION_ENDPOINTS, live.id)
        }
      } else if (entry.id && entry.prior) {
        // Deploy updated this rule — restore the captured prior values. Fields
        // whose prior value was unset get explicit empty values so anything the
        // deployment added is actually removed.
        const restore: Record<string, unknown> = {
          id: entry.id,
          rule_selection_type: entry.prior.rule_selection_type ?? 'all',
          rule_selection_filter: entry.prior.rule_selection_filter ?? {},
          scope_type: entry.prior.scope_type ?? 'account',
          scope_asset_filter: entry.prior.scope_asset_filter ?? {},
          description: entry.prior.description ?? '',
          suppression_reason: entry.prior.suppression_reason ?? '',
          suppression_expiration_date: entry.prior.suppression_expiration_date ?? '',
        }
        if (typeof entry.prior.disabled === 'boolean') restore.disabled = entry.prior.disabled
        await updateEntity(client, SUPPRESSION_ENDPOINTS, restore)
      }

      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} suppression rule(s): ${reverted.join(', ')}`,
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
