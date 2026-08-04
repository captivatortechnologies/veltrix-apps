import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildOpenctiUrl, buildAuthHeader, graphql } from '../../lib/openctiApi'
import { DELETE_TRIGGER_MUTATION, PATCH_TRIGGER_MUTATION, buildRestorePatch, type OpenctiTrigger } from './_shared'

/**
 * Undo a notification-triggers deploy from rollbackData.previous (written by
 * deploy()): for each entry with a prior body, triggerKnowledgeFieldPatch(id,
 * input) restores it (including its prior notifier/recipient ids); a newly
 * created trigger (prior body null) is deleted via triggerKnowledgeDelete(id).
 * Applied over the OpenCTI GraphQL API.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ name: string; triggerId: string | null; trigger: OpenctiTrigger | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for notification-trigger rollback' }
  }

  const base = buildOpenctiUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let restored = 0
  let deleted = 0
  let skipped = 0
  try {
    for (const { triggerId, trigger } of previous) {
      if (triggerId == null) {
        // A created trigger whose id we never learned — nothing safe to undo.
        skipped++
        continue
      }
      if (trigger) {
        await graphql(base, headers, PATCH_TRIGGER_MUTATION, { id: triggerId, input: buildRestorePatch(trigger) })
        restored++
      } else {
        await graphql(base, headers, DELETE_TRIGGER_MUTATION, { id: triggerId })
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back notification triggers: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
