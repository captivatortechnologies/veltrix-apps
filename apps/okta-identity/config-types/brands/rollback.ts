import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient, oktaErrorMessage } from '../../lib/okta'
import { type BrandRollbackEntry } from './deploy'

/**
 * Roll back brands using the state captured during deploy:
 *   - a brand this deploy CREATED is deleted (DELETE /brands/{id}). Its theme is
 *     removed with it, so the theme is not separately restored.
 *   - a brand this deploy UPDATED is PUT back to its captured prior body, and its
 *     theme (when changed) is PUT back to the captured prior theme.
 *
 * The default brand is never created, so it is never deleted here — only restored
 * in place. Rollback is keyed on the brand id Okta returned, never on the name.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: BrandRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        // Deploy created this brand — remove it (its theme goes with it).
        if (entry.id) {
          const del = await client.request('DELETE', `/brands/${entry.id}`)
          if (!del.ok && del.status !== 404) {
            throw new Error(
              `Failed to delete brand "${entry.name}": ${oktaErrorMessage(del)}. Okta will not delete a brand that is still in use (e.g. mapped to a domain or the default) — remove those references first.`,
            )
          }
        }
      } else if (entry.id) {
        // Deploy updated this brand — restore its prior body, then its prior theme.
        if (entry.priorBrand) {
          const res = await client.request('PUT', `/brands/${entry.id}`, { body: entry.priorBrand })
          if (!res.ok) {
            throw new Error(`Failed to restore brand "${entry.name}": ${oktaErrorMessage(res)}`)
          }
        }
        if (entry.themeId && entry.priorTheme) {
          const res = await client.request('PUT', `/brands/${entry.id}/themes/${entry.themeId}`, {
            body: entry.priorTheme,
          })
          if (!res.ok) {
            throw new Error(`Failed to restore theme for brand "${entry.name}": ${oktaErrorMessage(res)}`)
          }
        }
      }

      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} brand(s): ${reverted.join(', ')}.`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} brand(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
