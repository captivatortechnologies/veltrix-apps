import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildTinesClient, tinesErrorMessage } from '../../lib/tinesApi'
import type { StorySettingsRollbackEntry } from './deploy'

/**
 * Undo a Story Settings deploy from rollbackData.previousState (written by
 * deploy()), in reverse order. This NEVER deletes a story — it only restores
 * the prior settings snapshot via PUT /api/v1/stories/{id}:
 *   - tags this deploy ADDED are removed (remove_tag_names); tags it REMOVED
 *     are re-added (add_tag_names)
 *   - every other managed field is restored from the captured prior value
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildTinesClient(ctx.component?.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: StorySettingsRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: true, message: 'Nothing to roll back.' }
  }

  const reverted: string[] = []
  try {
    for (const entry of [...previousState].reverse()) {
      const body: Record<string, unknown> = {
        disabled: entry.prior.disabled ?? false,
        priority: entry.prior.priority ?? false,
        change_control_enabled: entry.prior.change_control_enabled ?? false,
        monitor_failures: entry.prior.monitor_failures ?? false,
      }
      if (entry.prior.description) body.description = entry.prior.description
      if (typeof entry.prior.keep_events_for === 'number') body.keep_events_for = entry.prior.keep_events_for
      if (entry.prior.folder_id) body.folder_id = entry.prior.folder_id
      if (entry.addedTags.length > 0) body.remove_tag_names = entry.addedTags
      if (entry.removedTags.length > 0) body.add_tag_names = entry.removedTags

      const res = await client.request('PUT', `/stories/${entry.id}`, { body })
      if (!res.ok) throw new Error(`Failed to restore settings for story "${entry.storyName}": ${tinesErrorMessage(res)}`)
      reverted.push(entry.storyName)
    }

    return { success: true, message: `Rolled back settings for ${reverted.length} story(ies): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
