import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  applyWithOptimisticRetry,
  buildSemgrepClient,
  remediationPoliciesBundleFromResponse,
  semgrepErrorMessage,
  semgrepWriteError,
  stateVersionFromResponse,
  type RemediationPoliciesBundle,
} from '../../lib/semgrepApi'
import { bundleFromSpecs, extractRemediationPolicySpecs, isCompleteSpec } from './_shared'

/** The deployment's whole prior remediation-policies bundle, captured before this deploy, for rollback. */
export interface RemediationPoliciesRollbackEntry {
  priorBundle: RemediationPoliciesBundle
}

/**
 * Deploy Semgrep Remediation Policies over the Policies V2 [Beta] API.
 *
 * The item LIST is the deployment's whole bundle:
 *   1. GET .../remediation-policies             → snapshot the prior bundle + state_version
 *   2. PUT .../remediation-policies (If-Match)   → strict-apply the declared list
 *      (policies absent from it are DELETED; system-managed policies are unaffected)
 * A 409 (stale state_version) triggers exactly one re-read + retry
 * (applyWithOptimisticRetry). rollbackData records the prior bundle so rollback
 * can restore it in one PUT.
 *
 * FLAGGED: submitting a slug that collides with a system-managed policy fails
 * with a clear message (RESERVED_SLUG) rather than silently doing nothing.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { credential, settings, canvas } = ctx

  if (!credential) {
    return { success: false, message: 'Missing credential for Semgrep Remediation Policies deployment' }
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

  const specs = extractRemediationPolicySpecs(canvas).filter(isCompleteSpec)

  try {
    const getRes = await client.getRemediationPolicies(deploymentId)
    if (!getRes.ok) {
      return { success: false, message: `Remediation Policies deploy failed: ${semgrepErrorMessage(getRes)}` }
    }
    const priorBundle = remediationPoliciesBundleFromResponse(getRes) ?? { policies: [] }
    const priorVersion = stateVersionFromResponse(getRes)
    if (!priorVersion) {
      return {
        success: false,
        message: 'Remediation Policies deploy failed: Semgrep did not return a state_version to synchronize on.',
      }
    }

    const bundle = bundleFromSpecs(specs)
    const res = await applyWithOptimisticRetry(
      (ifMatch) => client.applyRemediationPolicies(deploymentId, bundle, ifMatch),
      async () => stateVersionFromResponse(await client.getRemediationPolicies(deploymentId)),
      priorVersion,
    )
    const err = semgrepWriteError(res)
    if (err) {
      return {
        success: false,
        message: `Remediation Policies deploy failed: ${err}`,
        rollbackData: { priorBundle },
      }
    }

    const slugs = specs.map((s) => s.slug)
    return {
      success: true,
      message: `Applied ${slugs.length} remediation policy(ies): ${slugs.join(', ') || '(none)'}`,
      artifacts: { applied: slugs },
      rollbackData: { priorBundle },
    }
  } catch (error) {
    return { success: false, message: `Remediation Policies deploy failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
