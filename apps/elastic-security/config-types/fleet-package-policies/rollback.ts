import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildElasticClient, elasticErrorMessage } from '../../lib/elastic'
import type { LiveFleetPackagePolicy } from './validate'
import type { FleetPackagePolicyRollbackEntry } from './deploy'

/**
 * Roll back Fleet package policies using the state captured during deploy:
 *   - policies that were CREATED are deleted (DELETE /api/fleet/package_policies/{id});
 *     a 404 means it is already gone, which is the desired end state.
 *   - policies that were UPDATED are restored (PUT) to their captured prior body.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildElasticClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: FleetPackagePolicyRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        if (!entry.id) {
          // Nothing was ever created (deploy failed before create succeeded) — nothing to undo.
          reverted.push(entry.name)
          continue
        }
        const res = await client.kibana('DELETE', `/api/fleet/package_policies/${encodeURIComponent(entry.id)}`)
        if (res.status !== 404 && !res.ok) {
          throw new Error(`Failed to delete Fleet package policy "${entry.name}": ${elasticErrorMessage(res)}`)
        }
      } else if (entry.prior && entry.id) {
        const res = await client.kibana('PUT', `/api/fleet/package_policies/${encodeURIComponent(entry.id)}`, {
          body: buildRestoreBody(entry.prior),
        })
        if (!res.ok) {
          throw new Error(`Failed to restore Fleet package policy "${entry.name}": ${elasticErrorMessage(res)}`)
        }
      }

      reverted.push(entry.name)
    }

    return { success: true, message: `Rolled back ${reverted.length} Fleet package policy(ies): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} polic(y/ies): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}

/** Rebuild the update body from a captured prior policy, restoring it verbatim. */
function buildRestoreBody(prior: LiveFleetPackagePolicy): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: prior.name,
    namespace: prior.namespace ?? 'default',
    enabled: prior.enabled ?? true,
    policy_ids: prior.policy_ids ?? [],
    package: prior.package ?? {},
    inputs: prior.inputs ?? [],
  }
  if (prior.description !== undefined) body.description = prior.description
  if (prior.vars) body.vars = prior.vars
  return body
}
