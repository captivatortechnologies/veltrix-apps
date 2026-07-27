import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient, falconFailure, parseEnvelope } from '../../lib/falcon'
import {
  currentGroupIds,
  findPolicyByName,
  policyAction,
  syncHostGroups,
  type LivePolicy,
  type PolicyEndpoints,
} from '../../lib/policyAdapter'
import {
  extractPolicySpecs,
  flattenLiveSettings,
  parseResponseSettings,
  type PolicySetting,
} from './validate'

/** Response (Real Time Response) policy API paths for the shared policy adapter. */
export const RESPONSE_POLICY_ENDPOINTS: PolicyEndpoints = {
  entity: '/policy/entities/response/v1',
  combined: '/policy/combined/response/v1',
  actions: '/policy/entities/response-actions/v1',
  perPlatform: true,
}

export interface PolicyRollbackEntry {
  name: string
  platform: string
  existed: boolean
  id?: string
  prior?: {
    name?: string
    description?: string
    enabled?: boolean
    /** Prior values of only the settings this deployment changed. */
    settings: PolicySetting[]
    /** Host groups this deployment attached — rollback detaches them. */
    groupsAdded: string[]
    /** Host groups this deployment detached — rollback re-attaches them. */
    groupsRemoved: string[]
  }
}

/**
 * Deploy response policies to a Falcon tenant via the Response Policy API,
 * driven by the shared policy adapter (lib/policyAdapter).
 *
 * For each declared policy:
 *   - GET   /policy/combined/response/v1?filter=platform_name:'…'+name:~'…'  — find + capture prior state
 *   - PATCH /policy/entities/response/v1   — update existing (declared settings merge per-id)
 *   - POST  /policy/entities/response/v1   — create missing (new policies start disabled)
 *   - POST  …/response-actions/v1?action_name=enable|disable — converge enablement
 *   - POST  …?action_name=add-host-group|remove-host-group — converge assignments to the declared list
 *
 * Only the settings declared on the canvas are written; all other policy
 * settings keep their tenant values. platform_name is immutable via the API.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractPolicySpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: PolicyRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const { settings, errors: settingErrors } = parseResponseSettings(spec.settingsRaw)
      if (settingErrors.length > 0) {
        throw new Error(`Policy "${spec.name}": invalid settings — ${settingErrors[0]}`)
      }

      const existing = await findPolicyByName(
        client,
        RESPONSE_POLICY_ENDPOINTS,
        spec.name,
        spec.platform,
      )

      if (existing?.id) {
        const declaredIds = new Set(settings.map((s) => s.id))
        const entry: PolicyRollbackEntry = {
          name: spec.name,
          platform: spec.platform,
          existed: true,
          id: existing.id,
          prior: {
            name: existing.name,
            // Capture explicit empty so rollback can clear a description
            // this deployment sets on a policy that previously had none.
            description: existing.description ?? '',
            enabled: existing.enabled,
            settings: flattenLiveSettings(existing).filter((s) => declaredIds.has(s.id)),
            groupsAdded: [],
            groupsRemoved: [],
          },
        }
        rollbackState.push(entry)

        // description is always sent so clearing it on the canvas converges
        // the live policy (and drift detection agrees with deploy)
        const update: Record<string, unknown> = {
          id: existing.id,
          name: spec.name,
          description: spec.description ?? '',
        }
        if (settings.length > 0) update.settings = settings

        const res = await client.request('PATCH', RESPONSE_POLICY_ENDPOINTS.entity, {
          body: { resources: [update] },
        })
        const patchFailure = falconFailure(res)
        if (patchFailure) {
          throw new Error(`Failed to update policy "${spec.name}": ${patchFailure}`)
        }

        if (existing.enabled !== spec.enabled) {
          await policyAction(
            client,
            RESPONSE_POLICY_ENDPOINTS,
            existing.id,
            spec.enabled ? 'enable' : 'disable',
          )
        }
        // Records each successful attach/detach on entry.prior so rollback
        // can reverse exactly the assignments this deployment changed, even
        // after a partial failure.
        await syncHostGroups(
          client,
          RESPONSE_POLICY_ENDPOINTS,
          spec.name,
          existing.id,
          spec.hostGroups,
          currentGroupIds(existing),
          entry.prior,
        )
      } else {
        const create: Record<string, unknown> = { name: spec.name, platform_name: spec.platform }
        if (spec.description !== undefined) create.description = spec.description
        if (settings.length > 0) create.settings = settings

        const res = await client.request('POST', RESPONSE_POLICY_ENDPOINTS.entity, {
          body: { resources: [create] },
        })
        const createFailure = falconFailure(res)
        if (createFailure) {
          throw new Error(`Failed to create policy "${spec.name}": ${createFailure}`)
        }
        const created = parseEnvelope<LivePolicy>(res.body)?.resources?.[0]
        rollbackState.push({
          name: spec.name,
          platform: spec.platform,
          existed: false,
          id: created?.id,
        })
        if (!created?.id) {
          throw new Error(`Policy "${spec.name}" was created but the API returned no policy id`)
        }

        // New policies always start disabled
        if (spec.enabled) await policyAction(client, RESPONSE_POLICY_ENDPOINTS, created.id, 'enable')
        await syncHostGroups(
          client,
          RESPONSE_POLICY_ENDPOINTS,
          spec.name,
          created.id,
          spec.hostGroups,
          [],
        )
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} response policy(ies) to Falcon tenant at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedPolicies: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Response policy deployment failed after ${deployed.length} of ${specs.length} policy(ies): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedPolicies: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState },
    }
  }
}
