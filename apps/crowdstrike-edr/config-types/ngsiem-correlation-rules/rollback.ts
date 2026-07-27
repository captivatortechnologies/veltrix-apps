import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient } from '../../lib/falcon'
import { deleteEntity, findEntityByIdentity, updateEntity } from '../../lib/entityAdapter'
import { CORRELATION_RULE_ENDPOINTS, type CorrelationRuleRollbackEntry } from './deploy'

/**
 * Roll back correlation rules using the state captured during deploy:
 *   - rules that were created are deleted
 *   - rules that were updated are patched back to their prior values
 *
 * Both paths re-resolve the rule by name first: a write mints a new VERSION id,
 * so the id captured at deploy time is stale — the current head id is the one to
 * delete or restore against. A restore re-publish is NOT attempted; if the rule
 * was published, the restored draft version may need publishing in the console.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: CorrelationRuleRollbackEntry[] })
    ?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      const live = await findEntityByIdentity(client, CORRELATION_RULE_ENDPOINTS, entry.name)

      if (!entry.existed) {
        // Deploy created this rule — remove it. A concurrent delete makes the
        // missing rule a no-op instead of a hard error.
        if (live?.id) {
          await deleteEntity(client, CORRELATION_RULE_ENDPOINTS, live.id)
        }
      } else if (live?.id && entry.prior) {
        // Deploy updated this rule — restore the captured prior values.
        const prior = entry.prior
        const restore: Record<string, unknown> = { id: live.id, name: entry.name }
        if (prior.description !== undefined) restore.description = prior.description
        if (prior.severity !== undefined) restore.severity = prior.severity
        if (prior.status !== undefined) restore.status = prior.status
        if (prior.search !== undefined) restore.search = prior.search
        if (prior.operation !== undefined) restore.operation = prior.operation
        // Always re-send mitre_attack so a mapping the deployment added is removed.
        restore.mitre_attack = prior.mitre_attack ?? []

        await updateEntity(client, CORRELATION_RULE_ENDPOINTS, restore)
      }

      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} correlation rule(s): ${reverted.join(', ')}`,
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
