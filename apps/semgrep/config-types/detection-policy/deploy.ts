import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  applyWithOptimisticRetry,
  buildSemgrepClient,
  detectionPolicyBundleFromResponse,
  semgrepErrorMessage,
  semgrepWriteError,
  stateVersionFromResponse,
  type DetectionPolicyBundle,
  type DetectionPolicyProduct,
} from '../../lib/semgrepApi'
import { bundleFromSpec, extractDetectionPolicySpecs, isDetectionPolicyProduct } from './_shared'

/** One product's prior detection policy bundle captured before this deploy, for rollback. */
export interface DetectionPolicyRollbackEntry {
  product: string
  priorBundle: DetectionPolicyBundle
}

/**
 * Deploy Semgrep Detection Policy bundles over the Policies V2 [Beta] API.
 *
 * The current, non-deprecated replacement for the v1 Policies API. Per product
 * ("code" or "secrets"):
 *   1. GET .../detection-policy/{product}               → snapshot prior bundle + state_version
 *   2. PUT .../detection-policy/{product} (If-Match)     → strict-apply the declared bundle
 * A 409 (stale state_version) triggers exactly one re-read + retry
 * (applyWithOptimisticRetry). rollbackData records each product's prior bundle
 * so rollback can restore it.
 *
 * FLAGGED: a product not enabled for the deployment fails GET with 404
 * (PRODUCT_NOT_ENABLED) — surfaced with a clear message rather than silently
 * skipped.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { credential, settings, canvas } = ctx

  if (!credential) {
    return { success: false, message: 'Missing credential for Semgrep Detection Policy deployment' }
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

  const specs = extractDetectionPolicySpecs(canvas).filter((s) => isDetectionPolicyProduct(s.product) && s.exceptions !== null)
  const previous: DetectionPolicyRollbackEntry[] = []
  const applied: string[] = []

  try {
    for (const spec of specs) {
      const product = spec.product as DetectionPolicyProduct

      const getRes = await client.getDetectionPolicy(deploymentId, product)
      if (!getRes.ok) {
        const detail =
          getRes.status === 404 ? `product "${product}" is not enabled for this deployment.` : semgrepErrorMessage(getRes)
        return {
          success: false,
          message: `Detection Policy deploy failed: ${detail}`,
          artifacts: { applied },
          rollbackData: { previous },
        }
      }

      const priorBundle = detectionPolicyBundleFromResponse(getRes) ?? {}
      const priorVersion = stateVersionFromResponse(getRes)
      if (!priorVersion) {
        return {
          success: false,
          message: `Detection Policy deploy failed for "${product}": Semgrep did not return a state_version to synchronize on.`,
          artifacts: { applied },
          rollbackData: { previous },
        }
      }
      previous.push({ product, priorBundle })

      const bundle = bundleFromSpec(spec)
      const res = await applyWithOptimisticRetry(
        (ifMatch) => client.applyDetectionPolicy(deploymentId, product, bundle, ifMatch),
        async () => stateVersionFromResponse(await client.getDetectionPolicy(deploymentId, product)),
        priorVersion,
      )
      const err = semgrepWriteError(res)
      if (err) {
        return {
          success: false,
          message: `Detection Policy deploy failed for "${product}": ${err}`,
          artifacts: { applied },
          rollbackData: { previous },
        }
      }

      applied.push(product)
    }

    if (applied.length === 0) {
      return {
        success: true,
        message: 'No detection policies to apply.',
        artifacts: { applied: [] },
        rollbackData: { previous: [] },
      }
    }

    return {
      success: true,
      message: `Applied Detection Policy for ${applied.length} product(s): ${applied.join(', ')}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Detection Policy deploy failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
