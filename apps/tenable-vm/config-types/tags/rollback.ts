import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildTenableClient, tenableErrorMessage } from '../../lib/tenable'
import type { TagRollbackEntry } from './deploy'

/**
 * Roll back tags using the state captured during deploy:
 *   - tags that were created are deleted (DELETE /tags/values/{uuid})
 *   - tags that were updated are restored (PUT) to their prior body
 *
 * Deleting a tag value removes that tag from EVERY asset it was applied to, so
 * rolling back a freshly-created dynamic tag also un-tags the assets it had
 * auto-matched.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildTenableClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: TagRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      const label = `${entry.category}:${entry.value}`

      if (!entry.existed) {
        // Deploy created this tag value — remove it. 404 means it is already
        // gone (or was never created), which is the desired end state.
        if (entry.uuid) {
          const res = await client.request('DELETE', `/tags/values/${entry.uuid}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete tag "${label}": ${tenableErrorMessage(res)}`)
          }
        }
      } else if (entry.uuid && entry.prior) {
        // Deploy updated this tag value — restore the captured prior body.
        const restore: Record<string, unknown> = {}
        if (entry.prior.category_name !== undefined) restore.category_name = entry.prior.category_name
        if (entry.prior.value !== undefined) restore.value = entry.prior.value
        if (entry.prior.description !== undefined) restore.description = entry.prior.description
        if (entry.prior.filters !== undefined) restore.filters = entry.prior.filters

        const res = await client.request('PUT', `/tags/values/${entry.uuid}`, { body: restore })
        if (!res.ok) {
          throw new Error(`Failed to restore tag "${label}": ${tenableErrorMessage(res)}`)
        }
      }

      reverted.push(label)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} tag(s): ${reverted.join(', ')}. Note: deleting a tag value removes it from all assets it was applied to.`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} tag(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
