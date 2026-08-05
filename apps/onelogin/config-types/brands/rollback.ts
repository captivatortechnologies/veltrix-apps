import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildOneLoginClient, oneLoginErrorMessage, parseJson } from '../../lib/oneLogin'
import { buildBrandBody, type BrandRollbackEntry } from './deploy'
import type { LiveBrand } from './validate'

/**
 * Roll back brands using the state captured during deploy:
 *   - brands that were created are deleted (DELETE /api/2/branding/brands/{id},
 *     tolerate 404) - guarded so the account's MASTER brand is NEVER deleted,
 *     even defensively (a "created" entry should never point at the master
 *     brand by construction, since it already existed)
 *   - brands that were updated are restored (PUT) to their prior writable
 *     state
 *
 * Never touches a brand this deploy did not create or change.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildOneLoginClient(ctx.component.hostname, ctx.credential, ctx.settings)
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
        if (entry.id) {
          const liveRes = await client.request('GET', `/api/2/branding/brands/${entry.id}`)
          const live = liveRes.ok ? parseJson<LiveBrand>(liveRes.body) : null
          if (live?.master) {
            // Defensive guard only - a newly-created brand should never be master.
            reverted.push(`${entry.name} (skipped: master brand, never deleted)`)
            continue
          }
          const res = await client.request('DELETE', `/api/2/branding/brands/${entry.id}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete brand "${entry.name}": ${oneLoginErrorMessage(res)}`)
          }
        }
      } else if (entry.id && entry.prior) {
        const res = await client.request('PUT', `/api/2/branding/brands/${entry.id}`, { body: buildBrandBody(entry.prior) })
        if (!res.ok) {
          throw new Error(`Failed to restore brand "${entry.name}": ${oneLoginErrorMessage(res)}`)
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
