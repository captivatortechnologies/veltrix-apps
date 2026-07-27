import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient } from '../../lib/falcon'
import {
  createExclusion,
  exclusionGroupIds,
  findExclusion,
  updateExclusion,
  type ExclusionEndpoints,
} from '../../lib/exclusionAdapter'
import { DEPLOY_COMMENT, liveString, resolveDeployGroups } from '../ml-exclusions/exclusionShared'
import { extractIoaExclusionSpecs, type IoaExclusionSpec } from './validate'

/** Paths for the IOA Exclusions API surface. */
export const IOA_EXCLUSION_ENDPOINTS: ExclusionEndpoints = {
  entity: '/policy/entities/ioa-exclusions/v1',
  queries: '/policy/queries/ioa-exclusions/v1',
  identityField: 'name',
}

/** Exclusion fields this app manages and can restore on rollback. */
export interface IoaExclusionRollbackEntry {
  name: string
  existed: boolean
  id?: string
  prior?: {
    description?: string
    patternId?: string
    patternName?: string
    clRegex?: string
    ifnRegex?: string
    appliedGlobally: boolean
    groups: string[]
    comment?: string
  }
}

/**
 * Deploy IOA exclusions to a Falcon tenant via the IOA Exclusions API.
 *
 * For each declared exclusion:
 *   - find it by its `name` identity
 *   - if it exists, PATCH the managed fields (id + pattern + regexes + groups)
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

  const specs = extractIoaExclusionSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: IoaExclusionRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const existing = await findExclusion(client, IOA_EXCLUSION_ENDPOINTS, spec.name)
      const groups = resolveDeployGroups(spec.appliedGlobally, spec.hostGroups)

      if (existing?.id) {
        rollbackState.push({
          name: spec.name,
          existed: true,
          id: existing.id,
          prior: {
            description: liveString(existing.description) || undefined,
            patternId: liveString(existing.pattern_id) || undefined,
            patternName: liveString(existing.pattern_name) || undefined,
            clRegex: liveString(existing.cl_regex) || undefined,
            ifnRegex: liveString(existing.ifn_regex) || undefined,
            appliedGlobally: existing.applied_globally === true,
            groups: exclusionGroupIds(existing),
            comment: typeof existing.comment === 'string' ? existing.comment : undefined,
          },
        })

        await updateExclusion(client, IOA_EXCLUSION_ENDPOINTS, {
          id: existing.id,
          name: spec.name,
          ...buildManagedFields(spec),
          groups,
        })
      } else {
        const id = await createExclusion(client, IOA_EXCLUSION_ENDPOINTS, {
          name: spec.name,
          ...buildManagedFields(spec),
          groups,
        })
        rollbackState.push({ name: spec.name, existed: false, id })
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} IOA exclusion(s) to Falcon tenant at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedExclusions: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `IOA exclusion deployment failed after ${deployed.length} of ${specs.length} exclusion(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedExclusions: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState },
    }
  }
}

/** The mutable fields this app manages, as the IOA Exclusions API expects them. */
export function buildManagedFields(spec: IoaExclusionSpec): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    pattern_id: spec.patternId,
    cl_regex: spec.clRegex,
    ifn_regex: spec.ifnRegex,
    comment: spec.comment ?? DEPLOY_COMMENT,
  }
  if (spec.description) fields.description = spec.description
  if (spec.patternName) fields.pattern_name = spec.patternName
  return fields
}
