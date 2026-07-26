import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildPPClient, ppErrorMessage } from '../../lib/proofpoint'
import { extractFeatureSpecs, featureKey, getFeatures, readFeature } from './validate'

export interface FeatureRollbackEntry {
  feature: string
  existed: boolean
  prior: boolean
}

export interface FeatureRollbackData {
  previousState: FeatureRollbackEntry[]
}

/**
 * Deploy Proofpoint Essentials organization features via the features resource
 * (/orgs/{org}/features, read-modify-write PUT).
 *
 * Identity is the feature name. This is an UPSERT keyed on the feature: read the
 * org's current features, overlay each declared feature's enabled value, and PUT
 * the merged set back (features the deploy did not declare are preserved). The
 * prior value of each feature it changed is captured so rollback can restore it.
 *
 * Feature availability depends on the org's licensing package — enabling a feature
 * the package does not include is rejected by Proofpoint with HTTP 403; that error
 * is surfaced verbatim.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildPPClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl, orgDomain } = built

  const specs = extractFeatureSpecs(ctx.canvas).filter((s) => s.feature)

  try {
    const features = await getFeatures(client)
    const merged: Record<string, unknown> = { ...features }
    const rollbackState: FeatureRollbackEntry[] = []
    const changed: string[] = []
    const applied: string[] = []

    for (const spec of specs) {
      const key = featureKey(spec.feature)
      const current = readFeature(features, key)
      applied.push(`${key}=${spec.enabled}`)
      if (current === spec.enabled) continue // already in the desired state
      rollbackState.push({ feature: key, existed: current !== null, prior: current ?? false })
      merged[key] = spec.enabled
      changed.push(`${key}=${spec.enabled}`)
    }

    if (changed.length > 0) {
      const res = await client.request('PUT', `${client.orgPath}/features`, { body: merged })
      if (!res.ok) throw new Error(`Failed to update organization features: ${ppErrorMessage(res)}`)
    }

    return {
      success: true,
      message:
        `Deployed ${specs.length} feature(s) to Proofpoint Essentials org "${orgDomain}" ` +
        `(${changed.length} changed): ${applied.join(', ')}`,
      artifacts: { baseUrl, orgDomain, changed },
      rollbackData: { previousState: rollbackState } satisfies FeatureRollbackData,
    }
  } catch (error) {
    return {
      success: false,
      message: `Feature deployment failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { baseUrl, orgDomain },
      // A failed PUT leaves the features unchanged (the merge is applied in a
      // single request), so there is nothing to roll back.
      rollbackData: { previousState: [] } satisfies FeatureRollbackData,
    }
  }
}
