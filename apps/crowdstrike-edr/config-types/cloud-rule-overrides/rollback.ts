import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient } from '../../lib/falcon'
import { deleteEntity } from '../../lib/entityAdapter'
import {
  OVERRIDE_ENDPOINTS,
  findOverride,
  writeOverride,
  type OverrideRollbackEntry,
} from './deploy'

const ROLLBACK_COMMENT = 'Rollback by Veltrix (crowdstrike-edr app)'

/**
 * Roll back rule overrides using the state captured during deploy:
 *   - overrides that were created are deleted
 *   - overrides that were updated are patched back to their prior values
 * Created overrides are re-resolved by rule id before deletion so a concurrent
 * delete becomes a no-op rather than a hard error.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: OverrideRollbackEntry[] })
    ?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        // Deploy created this override — remove it.
        const live = await findOverride(client, entry.ruleId, entry.crn)
        const id = live?.id ?? entry.id
        if (id) {
          await deleteEntity(client, OVERRIDE_ENDPOINTS, id)
        }
      } else if (entry.prior) {
        // Deploy updated this override — restore the captured prior values.
        // Deploy-added fields are set to empty so they are actually removed.
        const restore: Record<string, unknown> = {
          rule_id: entry.ruleId,
          override_type: entry.prior.override_type ?? 'exception',
          overrides_details: entry.prior.overrides_details ?? '',
          reason: entry.prior.reason ?? '',
          comment: entry.prior.comment ?? ROLLBACK_COMMENT,
          target_region: entry.prior.target_region ?? '',
          expires_at: entry.prior.expires_at ?? '',
        }
        if (entry.crn) restore.crn = entry.crn
        await writeOverride(client, 'PATCH', restore)
      }

      reverted.push(entry.ruleId)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} rule override(s): ${reverted.join(', ')}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} override(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
