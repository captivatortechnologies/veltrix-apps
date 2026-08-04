import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildElasticClient, elasticErrorMessage } from '../../lib/elastic'
import { converge } from './deploy'
import type { LiveTransform } from './validate'
import type { TransformRollbackEntry } from './deploy'

/**
 * Roll back transforms using the state captured during deploy:
 *   - transforms that were CREATED are stopped (if running) then deleted
 *     (DELETE /_transform/{id}?force=true); a 404 means it is already gone.
 *   - transforms that were UPDATED have their mutable fields restored via
 *     POST /_transform/{id}/_update, then their running state (started/stopped)
 *     is converged back to what it was before this deploy.
 *
 * The pivot/latest aggregation itself is never restored — it is immutable and
 * was never changed by deploy's own update path.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildElasticClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: TransformRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      const id = entry.transformId

      if (!entry.existed) {
        await converge(client, id, false)
        const res = await client.elasticsearch('DELETE', `/_transform/${encodeURIComponent(id)}`, {
          query: { force: true },
        })
        if (res.status !== 404 && !res.ok) {
          throw new Error(`Failed to delete transform "${id}": ${elasticErrorMessage(res)}`)
        }
      } else if (entry.prior) {
        const res = await client.elasticsearch('POST', `/_transform/${encodeURIComponent(id)}/_update`, {
          body: buildRestoreBody(entry.prior),
        })
        if (!res.ok) {
          throw new Error(`Failed to restore transform "${id}": ${elasticErrorMessage(res)}`)
        }
        await converge(client, id, entry.wasRunning)
      }

      reverted.push(id)
    }

    return { success: true, message: `Rolled back ${reverted.length} transform(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} transform(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}

/** Rebuild the _update body from a captured prior config — the mutable subset only. */
function buildRestoreBody(prior: LiveTransform): Record<string, unknown> {
  const body: Record<string, unknown> = { source: prior.source ?? { index: [] }, dest: prior.dest ?? { index: '' } }
  if (prior.description !== undefined) body.description = prior.description
  if (prior.sync !== undefined) body.sync = prior.sync
  if (prior.frequency !== undefined) body.frequency = prior.frequency
  if (prior.settings !== undefined) body.settings = prior.settings
  if (prior.retention_policy !== undefined) body.retention_policy = prior.retention_policy
  return body
}
