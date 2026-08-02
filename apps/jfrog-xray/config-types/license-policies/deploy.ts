import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildXrayClient } from '../../lib/xrayApi'
import { createPolicy, getPolicyByName, listPolicies, putPolicy, type PolicyRollbackEntry } from '../../lib/xrayPolicies'
import { buildPolicyBody, extractLicensePolicySpecs, findPolicy, type XrayLicenseCriteria } from './_shared'

export type { PolicyRollbackEntry }

/**
 * Deploy JFrog Xray license policies over the Xray REST API v2 — the SAME
 * endpoints as security-policies (a policy of `type: "license"`):
 *   read (identity + rollback): GET  /api/v2/policies            → match by name
 *                                GET  /api/v2/policies/{name}     → full prior body, for rollback
 *   create:                     POST /api/v2/policies             with the full policy body
 *   update:                     PUT  /api/v2/policies/{name}      with the full policy body (Xray has
 *                                                                  no partial update — a PUT REPLACES
 *                                                                  the policy's rules wholesale)
 * Upserts by NAME. rollbackData records, per policy, whether it existed and (when it did) its full
 * prior body, so rollback can either delete what we created or PUT the exact prior state back.
 * CRUD-by-name primitives shared with security-policies via lib/xrayPolicies.ts.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildXrayClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, host } = built

  const specs = extractLicensePolicySpecs(ctx.canvas).filter((s) => s.name && s.ruleName)
  const rollbackState: PolicyRollbackEntry<XrayLicenseCriteria>[] = []
  const deployed: string[] = []

  try {
    const live = await listPolicies<XrayLicenseCriteria>(client)

    for (const spec of specs) {
      const desired = buildPolicyBody(spec)
      const existing = findPolicy(Array.isArray(live) ? live : [], spec.name)

      if (existing) {
        const prior = await getPolicyByName<XrayLicenseCriteria>(client, spec.name)
        rollbackState.push({ name: spec.name, existed: true, prior })
        await putPolicy(client, spec.name, desired)
      } else {
        rollbackState.push({ name: spec.name, existed: false })
        await createPolicy(client, desired)
      }
      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} Xray license polic${deployed.length === 1 ? 'y' : 'ies'} to ${host}: ${deployed.join(', ')}`,
      artifacts: { host, deployedPolicies: deployed },
      rollbackData: { previous: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Xray license-policy deployment failed after ${deployed.length} of ${specs.length}: ${errorMessage(error)}`,
      artifacts: { host, deployedPolicies: deployed },
      rollbackData: { previous: rollbackState },
    }
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : 'Unknown error'
}
