import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildOpenctiUrl, buildAuthHeader, graphql } from '../../lib/openctiApi'
import { DELETE_NOTIFIER_MUTATION, PATCH_NOTIFIER_MUTATION, buildRestorePatch, type OpenctiNotifier } from './_shared'

/**
 * Undo a notifiers deploy from rollbackData.previous (written by deploy()):
 * for each entry with a prior body, notifierFieldPatch(id, input) restores it;
 * a newly created notifier (prior body null) is deleted via
 * notifierDelete(id). Applied over the OpenCTI GraphQL API.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ name: string; notifierId: string | null; notifier: OpenctiNotifier | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for notifier rollback' }
  }

  const base = buildOpenctiUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let restored = 0
  let deleted = 0
  let skipped = 0
  try {
    for (const { notifierId, notifier } of previous) {
      if (notifierId == null) {
        // A created notifier whose id we never learned — nothing safe to undo.
        skipped++
        continue
      }
      if (notifier) {
        const input = buildRestorePatch(notifier)
        if (input.length > 0) {
          await graphql(base, headers, PATCH_NOTIFIER_MUTATION, { id: notifierId, input })
        }
        restored++
      } else {
        await graphql(base, headers, DELETE_NOTIFIER_MUTATION, { id: notifierId })
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back notifiers: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
