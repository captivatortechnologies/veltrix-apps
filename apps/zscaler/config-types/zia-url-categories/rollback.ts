import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildZscalerClient, zscalerErrorMessage } from '../../lib/zscaler'
import type { UrlCategoryRollbackEntry } from './deploy'

/**
 * Roll back ZIA custom URL categories using the state captured during deploy:
 *   - categories that were created are deleted (DELETE /urlCategories/{id})
 *   - categories that were updated are restored (PUT) to their prior body
 * Predefined categories are never captured during deploy (it throws on a match),
 * so they are never touched here. Ids are STRINGs ("CUSTOM_xx"). Reverting is
 * itself a staged change, so this activates once at the end.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: UrlCategoryRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    // Reverse order so newer changes are undone first.
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id != null) {
          const res = await client.zia('DELETE', `/urlCategories/${entry.id}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete URL category "${entry.configuredName}": ${zscalerErrorMessage(res)}`)
          }
        }
      } else if (entry.id != null && entry.prior) {
        const restore: Record<string, unknown> = {
          configuredName: entry.prior.configuredName ?? entry.configuredName,
          superCategory: entry.prior.superCategory ?? 'USER_DEFINED',
          type: entry.prior.type ?? 'URL_CATEGORY',
          urls: entry.prior.urls ?? [],
          description: entry.prior.description ?? '',
          customCategory: true,
        }
        if (entry.prior.keywords) restore.keywords = entry.prior.keywords
        const res = await client.zia('PUT', `/urlCategories/${entry.id}`, { body: restore })
        if (!res.ok) {
          throw new Error(`Failed to restore URL category "${entry.configuredName}": ${zscalerErrorMessage(res)}`)
        }
      }
      reverted.push(entry.configuredName)
    }

    const act = await client.activate()
    if (!act.ok) {
      return {
        success: false,
        message: `Reverted ${reverted.length} URL category(ies) but activation failed: ${zscalerErrorMessage(
          act,
        )}. Re-run rollback to retry activation.`,
      }
    }

    return {
      success: true,
      message: `Rolled back and activated ${reverted.length} ZIA URL category(ies): ${reverted.join(', ')}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} category(ies): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
