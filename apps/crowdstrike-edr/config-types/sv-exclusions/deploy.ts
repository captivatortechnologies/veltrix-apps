import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient } from '../../lib/falcon'
import {
  createExclusion,
  exclusionGroupIds,
  findExclusion,
  updateExclusion,
  type ExclusionEndpoints,
} from '../../lib/exclusionAdapter'
import { DEPLOY_COMMENT, resolveDeployGroups } from '../ml-exclusions/exclusionShared'
import { extractSvExclusionSpecs } from './validate'

/** Paths for the Sensor Visibility Exclusions API surface. */
export const SV_EXCLUSION_ENDPOINTS: ExclusionEndpoints = {
  entity: '/policy/entities/sv-exclusions/v1',
  queries: '/policy/queries/sv-exclusions/v1',
  identityField: 'value',
}

/** Exclusion fields this app manages and can restore on rollback. */
export interface SvExclusionRollbackEntry {
  value: string
  existed: boolean
  id?: string
  prior?: {
    appliedGlobally: boolean
    groups: string[]
    comment?: string
  }
}

/**
 * Deploy sensor visibility exclusions to a Falcon tenant.
 *
 * For each declared exclusion:
 *   - find it by its `value` identity
 *   - if it exists, PATCH the managed fields (id + groups)
 *   - otherwise POST a new exclusion
 *
 * Host-group membership is converged by re-sending the full `groups` array; the
 * sentinel ["all"] applies the exclusion globally (there is no applied_globally
 * write field). Prior state is captured so rollback can revert updates and
 * delete anything this deploy created.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractSvExclusionSpecs(ctx.canvas).filter((s) => s.value)
  const rollbackState: SvExclusionRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const existing = await findExclusion(client, SV_EXCLUSION_ENDPOINTS, spec.value)
      const groups = resolveDeployGroups(spec.appliedGlobally, spec.hostGroups)

      if (existing?.id) {
        rollbackState.push({
          value: spec.value,
          existed: true,
          id: existing.id,
          prior: {
            appliedGlobally: existing.applied_globally === true,
            groups: exclusionGroupIds(existing),
            comment: typeof existing.comment === 'string' ? existing.comment : undefined,
          },
        })

        await updateExclusion(client, SV_EXCLUSION_ENDPOINTS, {
          id: existing.id,
          value: spec.value,
          groups,
          comment: spec.comment ?? DEPLOY_COMMENT,
        })
      } else {
        const id = await createExclusion(client, SV_EXCLUSION_ENDPOINTS, {
          value: spec.value,
          groups,
          comment: spec.comment ?? DEPLOY_COMMENT,
        })
        rollbackState.push({ value: spec.value, existed: false, id })
      }

      deployed.push(spec.value)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} sensor visibility exclusion(s) to Falcon tenant at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedExclusions: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Sensor visibility exclusion deployment failed after ${deployed.length} of ${specs.length} exclusion(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedExclusions: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState },
    }
  }
}
