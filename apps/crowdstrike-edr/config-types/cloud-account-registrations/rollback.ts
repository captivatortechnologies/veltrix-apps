import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient, falconFailure } from '../../lib/falcon'
import { identityBody, providerPath, UPDATE_METHOD, type AccountRollbackEntry } from './deploy'

/**
 * Roll back cloud account registrations using the state captured during deploy:
 *   - accounts this deployment registered are deregistered (DELETE {path}?ids=…)
 *   - accounts this deployment updated are patched back to their prior fields
 *
 * Deregistering here only removes the Falcon-side registration; any trust role
 * / stack the customer created out-of-band in their cloud is theirs to remove.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: AccountRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      const path = providerPath(entry.cloudProvider)
      if (!path) continue
      const label = `${entry.cloudProvider}:${entry.identity}`

      if (!entry.existed) {
        // Deploy registered this account — deregister it. 404 means it was
        // never created (or already removed), which is the desired state.
        const res = await client.request('DELETE', path, { query: { ids: entry.identity } })
        const deleteFailure = res.status === 404 ? null : falconFailure(res)
        if (deleteFailure) {
          throw new Error(`Failed to deregister ${label}: ${deleteFailure}`)
        }
      } else if (entry.prior) {
        // Deploy updated this account — restore the captured prior fields.
        const restore: Record<string, unknown> = { ...identityBody(entry.cloudProvider, entry.identity) }
        const prior = entry.prior
        if (prior.iam_role_arn !== undefined) restore.iam_role_arn = prior.iam_role_arn
        if (prior.cloudtrail_region !== undefined) restore.cloudtrail_region = prior.cloudtrail_region
        if (prior.default_subscription !== undefined) restore.default_subscription = prior.default_subscription
        if (prior.behavior_assessment_enabled !== undefined) {
          restore.behavior_assessment_enabled = prior.behavior_assessment_enabled
        }
        if (prior.sensor_management_enabled !== undefined) {
          restore.sensor_management_enabled = prior.sensor_management_enabled
        }
        if (prior.dspm_enabled !== undefined) restore.dspm_enabled = prior.dspm_enabled

        const res = await client.request(UPDATE_METHOD, path, { body: { resources: [restore] } })
        const restoreFailure = falconFailure(res)
        if (restoreFailure) {
          throw new Error(`Failed to restore ${label}: ${restoreFailure}`)
        }
      }

      reverted.push(label)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} cloud account registration(s): ${reverted.join(', ')}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} account(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
