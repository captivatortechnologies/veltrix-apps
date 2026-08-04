import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildElasticClient, elasticErrorMessage } from '../../lib/elastic'
import type { LiveRole } from './validate'
import type { RoleRollbackEntry } from './deploy'

/**
 * Roll back roles using the state captured during deploy:
 *   - roles that were CREATED are deleted (DELETE /_security/role/{name});
 *     a 404 means it is already gone, which is the desired end state.
 *   - roles that were UPDATED are restored (PUT) to their captured prior body.
 *
 * Only native (API-defined), non-reserved roles are ever in the rollback set —
 * deploy fails before capturing anything when a name collides with a reserved
 * role.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildElasticClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: RoleRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        const res = await client.elasticsearch('DELETE', `/_security/role/${encodeURIComponent(entry.name)}`)
        if (res.status !== 404 && !res.ok) {
          throw new Error(`Failed to delete role "${entry.name}": ${elasticErrorMessage(res)}`)
        }
      } else if (entry.prior) {
        const res = await client.elasticsearch('PUT', `/_security/role/${encodeURIComponent(entry.name)}`, {
          body: buildRestoreBody(entry.prior),
        })
        if (!res.ok) {
          throw new Error(`Failed to restore role "${entry.name}": ${elasticErrorMessage(res)}`)
        }
      }

      reverted.push(entry.name)
    }

    return { success: true, message: `Rolled back ${reverted.length} role(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} role(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}

/** Rebuild the upsert body from a captured prior role, restoring it verbatim (including any reserved metadata keys). */
function buildRestoreBody(prior: LiveRole): Record<string, unknown> {
  const body: Record<string, unknown> = {
    cluster: prior.cluster ?? [],
    indices: prior.indices ?? [],
    applications: prior.applications ?? [],
    run_as: prior.run_as ?? [],
  }
  if (prior.description !== undefined) body.description = prior.description
  if (prior.metadata) body.metadata = prior.metadata
  return body
}
