import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  applyWithOptimisticRetry,
  buildSemgrepClient,
  semgrepWriteError,
  stateVersionFromResponse,
  type DetectionPolicyProduct,
} from '../../lib/semgrepApi'
import type { DetectionPolicyRollbackEntry } from './deploy'

/**
 * Undo a Detection Policy deploy from rollbackData.previous (written by
 * deploy()): per product, re-GET the CURRENT state_version (never the one
 * captured before this deploy — it may already be stale) and PUT the prior
 * bundle back under that fresh If-Match.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { credential, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: DetectionPolicyRollbackEntry[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for Detection Policy rollback' }
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

  const restored: string[] = []

  try {
    for (const entry of previous) {
      const product = entry.product as DetectionPolicyProduct

      const getRes = await client.getDetectionPolicy(deploymentId, product)
      const currentVersion = stateVersionFromResponse(getRes)
      if (!getRes.ok || !currentVersion) {
        return {
          success: false,
          message: `Rollback failed for "${entry.product}": could not read the current state_version to restore against.`,
        }
      }

      const res = await applyWithOptimisticRetry(
        (ifMatch) => client.applyDetectionPolicy(deploymentId, product, entry.priorBundle, ifMatch),
        async () => stateVersionFromResponse(await client.getDetectionPolicy(deploymentId, product)),
        currentVersion,
      )
      const err = semgrepWriteError(res)
      if (err) return { success: false, message: `Rollback failed for "${entry.product}": ${err}` }
      restored.push(entry.product)
    }

    return { success: true, message: `Rolled back Detection Policy for ${restored.length} product(s): ${restored.join(', ') || '(none)'}` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
