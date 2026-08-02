import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildXrayClient, xrayErrorMessage } from '../../lib/xrayApi'
import { buildPolicyBody, extractPolicySpecs, findPolicy, policyKey, type XraySecurityPolicy } from './_shared'

const POLICIES_PATH = '/api/v2/policies'
const policyPath = (name: string): string => `${POLICIES_PATH}/${encodeURIComponent(name)}`

export interface PolicyRollbackEntry {
  name: string
  existed: boolean
  /** The full prior policy body (read before the PUT) — used to restore an updated policy on rollback. */
  prior?: XraySecurityPolicy
}

/**
 * Deploy JFrog Xray security policies over the Xray REST API v2:
 *   read (identity + rollback): GET  /api/v2/policies            → match by name
 *                                GET  /api/v2/policies/{name}     → full prior body, for rollback
 *   create:                     POST /api/v2/policies             with the full policy body
 *   update:                     PUT  /api/v2/policies/{name}      with the full policy body (Xray has
 *                                                                  no partial update — a PUT REPLACES
 *                                                                  the policy's rules wholesale)
 * Upserts by NAME. rollbackData records, per policy, whether it existed and (when it did) its full
 * prior body, so rollback can either delete what we created or PUT the exact prior state back.
 *
 * A policy's `watches[]` binding is a separate Xray object (Watches) and is intentionally not
 * managed here — see config-types/security-policies/../../README.md.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildXrayClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, host } = built

  const specs = extractPolicySpecs(ctx.canvas).filter((s) => s.name && s.ruleName)
  const rollbackState: PolicyRollbackEntry[] = []
  const deployed: string[] = []

  try {
    const live = await client.getJson<XraySecurityPolicy[]>(POLICIES_PATH)

    for (const spec of specs) {
      const desired = buildPolicyBody(spec)
      const existing = findPolicy(Array.isArray(live) ? live : [], spec.name)

      if (existing) {
        const prior = await client.getJson<XraySecurityPolicy>(policyPath(spec.name))
        rollbackState.push({ name: spec.name, existed: true, prior })
        await client.putJson(policyPath(spec.name), desired)
      } else {
        rollbackState.push({ name: spec.name, existed: false })
        await client.postJson(POLICIES_PATH, desired)
      }
      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} Xray security polic${deployed.length === 1 ? 'y' : 'ies'} to ${host}: ${deployed.join(', ')}`,
      artifacts: { host, deployedPolicies: deployed },
      rollbackData: { previous: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Xray security-policy deployment failed after ${deployed.length} of ${specs.length}: ${errorMessage(error)}`,
      artifacts: { host, deployedPolicies: deployed },
      rollbackData: { previous: rollbackState },
    }
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : 'Unknown error'
}

// Re-exported so rollback.ts / healthCheck.ts / driftDetect.ts share the exact
// same path helpers and never diverge from the deploy path shape.
export { POLICIES_PATH, policyPath, xrayErrorMessage }
