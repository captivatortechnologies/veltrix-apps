import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient, falconFailure } from '../../lib/falcon'
import type { IocRollbackEntry } from './deploy'

const ROLLBACK_COMMENT = 'Rollback by Veltrix (crowdstrike-edr app)'

/**
 * Roll back custom IOCs using the state captured during deploy:
 *   - indicators that were created are deleted (DELETE /iocs/entities/indicators/v1)
 *   - indicators that were updated are patched back to their prior values
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: IocRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []
  const uncleardExpirations: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        // Deploy created this indicator — remove it. 404 means it was never
        // created (or already removed), which is the desired state.
        if (entry.id) {
          const res = await client.request('DELETE', '/iocs/entities/indicators/v1', {
            query: { ids: entry.id, comment: ROLLBACK_COMMENT },
          })
          const deleteFailure = res.status === 404 ? null : falconFailure(res)
          if (deleteFailure) {
            throw new Error(
              `Failed to delete indicator "${entry.value}" (${entry.type}): ${deleteFailure}`,
            )
          }
        }
      } else if (entry.id && entry.prior) {
        // Deploy updated this indicator — restore the captured prior values.
        // Fields whose prior value was unset get explicit empty values so a
        // description/tags the deployment added are actually removed.
        const restore: Record<string, unknown> = { id: entry.id }
        if (entry.prior.action !== undefined) restore.action = entry.prior.action
        if (entry.prior.severity !== undefined) restore.severity = entry.prior.severity
        if (entry.prior.platforms !== undefined) restore.platforms = entry.prior.platforms
        if (entry.prior.applied_globally !== undefined) {
          restore.applied_globally = entry.prior.applied_globally
        }
        if (entry.prior.host_groups !== undefined) restore.host_groups = entry.prior.host_groups
        restore.description = entry.prior.description ?? ''
        restore.tags = entry.prior.tags ?? []
        if (entry.prior.expiration !== undefined) {
          restore.expiration = entry.prior.expiration
        } else {
          // The API has no verified way to clear an expiration via PATCH —
          // if the deployment added one, it must be removed in the console.
          uncleardExpirations.push(`${entry.value} (${entry.type})`)
        }

        const res = await client.request('PATCH', '/iocs/entities/indicators/v1', {
          body: { comment: ROLLBACK_COMMENT, indicators: [restore] },
        })
        const restoreFailure = falconFailure(res)
        if (restoreFailure) {
          throw new Error(
            `Failed to restore indicator "${entry.value}" (${entry.type}): ${restoreFailure}`,
          )
        }
      }

      reverted.push(entry.value)
    }

    const expirationNote =
      uncleardExpirations.length > 0
        ? ` Note: expirations cannot be cleared via the API — if the deployment added one to ${uncleardExpirations.join(
            ', ',
          )}, remove it in the Falcon console.`
        : ''
    return {
      success: true,
      message: `Rolled back ${reverted.length} custom IOC(s): ${reverted.join(', ')}.${expirationNote}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} indicator(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
