import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient, falconFailure, parseEnvelope } from '../../lib/falcon'
import {
  currentGroupIds,
  findPolicyByName,
  policyAction,
  syncHostGroups,
  type LivePolicy,
} from '../../lib/policyAdapter'
import {
  DEVICE_CONTROL_ENDPOINTS,
  asSettingsObject,
  extractDeviceControlSpecs,
  parseDeviceControlSettings,
} from './validate'

export interface DeviceControlRollbackEntry {
  name: string
  platform: string
  existed: boolean
  id?: string
  prior?: {
    name?: string
    description?: string
    enabled?: boolean
    /** Prior full settings object — only captured when this deployment writes settings. */
    settings?: Record<string, unknown> | null
    /** Host groups this deployment attached — rollback detaches them. */
    groupsAdded: string[]
    /** Host groups this deployment detached — rollback re-attaches them. */
    groupsRemoved: string[]
  }
}

/**
 * Deploy device control policies to a Falcon tenant via the Device Control
 * Policy API (v2 entity, v1 combined/actions).
 *
 * For each declared policy:
 *   - GET   /policy/combined/device-control/v1?filter=platform_name:'…'+name:~'…'  — find + capture prior state
 *   - PATCH /policy/entities/device-control/v2   — update existing (whole settings object)
 *   - POST  /policy/entities/device-control/v2   — create missing (new policies start disabled)
 *   - POST  …/device-control-actions/v1?action_name=enable|disable — converge enablement
 *   - POST  …?action_name=add-host-group|remove-host-group — converge assignments to the declared list
 *
 * The settings object is written as-is; classes not listed keep their tenant
 * values. platform_name is immutable via the API.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractDeviceControlSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: DeviceControlRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const { settings, errors: settingErrors } = parseDeviceControlSettings(spec.settingsRaw)
      if (settingErrors.length > 0) {
        throw new Error(`Policy "${spec.name}": invalid settings — ${settingErrors[0]}`)
      }

      const existing = await findPolicyByName(
        client,
        DEVICE_CONTROL_ENDPOINTS,
        spec.name,
        spec.platform,
      )

      if (existing?.id) {
        const entry: DeviceControlRollbackEntry = {
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
            // Only recorded when this deployment overwrites settings.
            settings: settings ? asSettingsObject(existing.settings) : undefined,
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
        if (settings) update.settings = settings

        const res = await client.request('PATCH', DEVICE_CONTROL_ENDPOINTS.entity, {
          body: { resources: [update] },
        })
        const patchFailure = falconFailure(res)
        if (patchFailure) {
          throw new Error(`Failed to update policy "${spec.name}": ${patchFailure}`)
        }

        if (existing.enabled !== spec.enabled) {
          await policyAction(
            client,
            DEVICE_CONTROL_ENDPOINTS,
            existing.id,
            spec.enabled ? 'enable' : 'disable',
          )
        }
        // Records each successful attach/detach on entry.prior so rollback
        // can reverse exactly the assignments this deployment changed, even
        // after a partial failure.
        await syncHostGroups(
          client,
          DEVICE_CONTROL_ENDPOINTS,
          spec.name,
          existing.id,
          spec.hostGroups,
          currentGroupIds(existing),
          entry.prior,
        )
      } else {
        const create: Record<string, unknown> = { name: spec.name, platform_name: spec.platform }
        if (spec.description !== undefined) create.description = spec.description
        if (settings) create.settings = settings

        const res = await client.request('POST', DEVICE_CONTROL_ENDPOINTS.entity, {
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
        if (spec.enabled) await policyAction(client, DEVICE_CONTROL_ENDPOINTS, created.id, 'enable')
        await syncHostGroups(client, DEVICE_CONTROL_ENDPOINTS, spec.name, created.id, spec.hostGroups, [])
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} device control policy(ies) to Falcon tenant at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedPolicies: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Device control policy deployment failed after ${deployed.length} of ${specs.length} policy(ies): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedPolicies: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState },
    }
  }
}
