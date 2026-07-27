import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient, falconFailure, sameSet, type FalconClient } from '../../lib/falcon'
import {
  createEntity,
  findEntityByIdentity,
  updateEntity,
  type EntityEndpoints,
} from '../../lib/entityAdapter'
import {
  extractITPolicySpecs,
  parsePolicyConfig,
  readLiveEnabled,
  readLiveHostGroups,
  type LiveITPolicy,
} from './validate'

/**
 * IT Automation Policy API surface (verified against FalconPy `it_automation`).
 * query→get→create→update→delete match the generic entity adapter; identity is
 * `name`. Host-group assignment and precedence are SEPARATE endpoints.
 */
export const IT_POLICY_ENDPOINTS: EntityEndpoints = {
  entity: '/it-automation/entities/policies/v1',
  queries: '/it-automation/queries/policies/v1',
  identityField: 'name',
}

/** PATCH endpoint that assigns/updates a policy's host groups. */
export const IT_POLICY_HOST_GROUPS_PATH = '/it-automation/entities/policies-host-groups/v1'

/**
 * UNVERIFIED: the exact `action` enum for policies-host-groups is not published
 * (FalconPy passes the string through without restricting it). We treat the
 * endpoint as a full-set assignment with action "assign" — sending the complete
 * desired list — and document it so a wrong enum fails LOUDLY at deploy rather
 * than drifting silently. Drift compares host groups against the confirmed live
 * field only, so a mis-shaped write here never manufactures false drift.
 */
export const HOST_GROUP_ASSIGN_ACTION = 'assign'

/** IT automation policy fields this app manages and can restore on rollback. */
export interface ITPolicyRollbackEntry {
  name: string
  platform: string
  existed: boolean
  id?: string
  prior?: {
    description?: string
    enabled?: boolean
    /** Full prior config object (restored verbatim). */
    config?: Record<string, unknown>
    /** Prior host groups, when the live policy exposed them. */
    hostGroups?: string[]
    /** Whether this deploy actually changed the host-group assignment. */
    hostGroupsChanged: boolean
  }
}

/**
 * Deploy IT automation policies to a Falcon tenant via the Policy API.
 *
 * For each declared policy:
 *   - find it by its `name` identity (query → get, via the entity adapter)
 *   - if it exists, PATCH the managed fields (name, description, is_enabled,
 *     config) and converge host groups via the policies-host-groups endpoint
 *   - otherwise POST a new policy, then assign host groups
 *
 * platform is immutable and only sent on create. Only the config keys the
 * canvas declares are written; all other policy settings keep tenant values.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractITPolicySpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: ITPolicyRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const { config, errors: configErrors } = parsePolicyConfig(spec.configRaw)
      if (configErrors.length > 0) {
        throw new Error(`Policy "${spec.name}": invalid execution config — ${configErrors[0]}`)
      }

      const existing = (await findEntityByIdentity(
        client,
        IT_POLICY_ENDPOINTS,
        spec.name,
      )) as LiveITPolicy | null

      if (existing?.id) {
        const priorHostGroups = readLiveHostGroups(existing)
        const entry: ITPolicyRollbackEntry = {
          name: spec.name,
          platform: spec.platform,
          existed: true,
          id: existing.id,
          prior: {
            description: existing.description ?? '',
            enabled: readLiveEnabled(existing),
            config: existing.config,
            hostGroups: priorHostGroups,
            hostGroupsChanged: false,
          },
        }
        rollbackState.push(entry)

        const update: Record<string, unknown> = {
          id: existing.id,
          name: spec.name,
          description: spec.description ?? '',
          is_enabled: spec.enabled,
        }
        if (config) update.config = config

        await updateEntity(client, IT_POLICY_ENDPOINTS, update)

        // Converge host groups only when the declared list differs from live —
        // and only when live exposed them, so we never blow away an assignment
        // we could not read.
        if (priorHostGroups !== undefined && !sameSet(priorHostGroups, spec.hostGroups)) {
          await assignPolicyHostGroups(client, spec.name, existing.id, spec.hostGroups)
          if (entry.prior) entry.prior.hostGroupsChanged = true
        }
      } else {
        const create: Record<string, unknown> = {
          name: spec.name,
          platform: spec.platform,
          is_enabled: spec.enabled,
        }
        if (spec.description !== undefined) create.description = spec.description
        if (config) create.config = config

        const id = await createEntity(client, IT_POLICY_ENDPOINTS, create)
        rollbackState.push({ name: spec.name, platform: spec.platform, existed: false, id })

        if (spec.hostGroups.length > 0) {
          await assignPolicyHostGroups(client, spec.name, id, spec.hostGroups)
        }
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} IT automation policy(ies) to Falcon tenant at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedPolicies: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `IT automation policy deployment failed after ${deployed.length} of ${specs.length} policy(ies): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedPolicies: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState },
    }
  }
}

// --- Helpers ---

/**
 * Assign a policy's host groups to exactly the declared list via the
 * policies-host-groups endpoint. See HOST_GROUP_ASSIGN_ACTION — the action enum
 * is unverified, so a rejection surfaces here rather than silently.
 */
export async function assignPolicyHostGroups(
  client: FalconClient,
  policyName: string,
  policyId: string,
  hostGroupIds: string[],
): Promise<void> {
  const res = await client.request('PATCH', IT_POLICY_HOST_GROUPS_PATH, {
    body: { action: HOST_GROUP_ASSIGN_ACTION, policy_id: policyId, host_group_ids: hostGroupIds },
  })
  const failure = falconFailure(res)
  if (failure) {
    throw new Error(`Policy "${policyName}": failed to assign host groups — ${failure}`)
  }
}
