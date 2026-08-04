import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { applyWithOptimisticRetry, buildSemgrepClient, semgrepWriteError, stateVersionFromResponse } from '../../lib/semgrepApi'
import type { RemediationPoliciesRollbackEntry } from './deploy'

/**
 * Undo a Remediation Policies deploy from rollbackData.priorBundle (written by
 * deploy()): re-GET the CURRENT state_version (never the one captured before
 * this deploy — it may already be stale) and PUT the prior whole bundle back
 * under that fresh If-Match.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { credential, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as Partial<RemediationPoliciesRollbackEntry>
  if (!data.priorBundle) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for Remediation Policies rollback' }
  }

  const built = buildSemgrepClient(credential, settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built
  if (!client.hasSlug) {
    return { success: false, message: 'No Semgrep deployment slug set — configure the "Deployment Slug" app setting.' }
  }

  let deploymentId: number
  try {
    const resolved = await client.resolveDeploymentId()
    if ('error' in resolved) return { success: false, message: resolved.error }
    deploymentId = resolved.id
  } catch (error) {
    return {
      success: false,
      message: `Failed to resolve the Semgrep deployment id: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }

  try {
    const getRes = await client.getRemediationPolicies(deploymentId)
    const currentVersion = stateVersionFromResponse(getRes)
    if (!getRes.ok || !currentVersion) {
      return { success: false, message: 'Rollback failed: could not read the current state_version to restore against.' }
    }

    const priorBundle = data.priorBundle
    const res = await applyWithOptimisticRetry(
      (ifMatch) => client.applyRemediationPolicies(deploymentId, priorBundle, ifMatch),
      async () => stateVersionFromResponse(await client.getRemediationPolicies(deploymentId)),
      currentVersion,
    )
    const err = semgrepWriteError(res)
    if (err) return { success: false, message: `Rollback failed: ${err}` }

    return {
      success: true,
      message: `Rolled back Remediation Policies to ${priorBundle.policies.length} prior policy(ies).`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
