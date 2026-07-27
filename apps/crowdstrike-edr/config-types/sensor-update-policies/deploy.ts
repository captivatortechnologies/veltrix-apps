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
  buildSensorSettings,
  extractPolicySpecs,
  readSensorSettings,
  type SensorUpdateSettings,
} from './validate'

/** Sensor Update Policy API surface — the v2 entity/actions family. */
export const SENSOR_UPDATE_ENDPOINTS: PolicyEndpoints = {
  entity: '/policy/entities/sensor-update/v2',
  combined: '/policy/combined/sensor-update/v1',
  actions: '/policy/entities/sensor-update-actions/v2',
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
    /** Prior build + uninstall_protection this deployment overwrote. */
    settings: SensorUpdateSettings
    /** Host groups this deployment attached — rollback detaches them. */
    groupsAdded: string[]
    /** Host groups this deployment detached — rollback re-attaches them. */
    groupsRemoved: string[]
  }
}

/**
 * Deploy sensor update policies to a Falcon tenant via the Sensor Update Policy
 * API. For each declared policy:
 *   - find by name + platform (combined query, exact-name pin)
 *   - PATCH existing (name, description, settings) or POST create (name,
 *     platform_name, description, settings) — new policies start disabled
 *   - converge enablement via the sensor-update-actions call
 *   - converge host group assignments to exactly the declared list
 *
 * Only build + uninstall_protection are managed; platform_name is immutable and
 * the scheduler keeps its tenant value.
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
      const settings = buildSensorSettings(spec)
      const existing = await findPolicyByName(
        client,
        SENSOR_UPDATE_ENDPOINTS,
        spec.name,
        spec.platform,
      )

      if (existing?.id) {
        const entry: PolicyRollbackEntry = {
          name: spec.name,
          platform: spec.platform,
          existed: true,
          id: existing.id,
          prior: {
            name: existing.name,
            description: existing.description ?? '',
            enabled: existing.enabled,
            settings: readSensorSettings(existing),
            groupsAdded: [],
            groupsRemoved: [],
          },
        }
        rollbackState.push(entry)

        const update: Record<string, unknown> = {
          id: existing.id,
          name: spec.name,
          description: spec.description ?? '',
          settings,
        }

        const res = await client.request('PATCH', SENSOR_UPDATE_ENDPOINTS.entity, {
          body: { resources: [update] },
        })
        const patchFailure = falconFailure(res)
        if (patchFailure) {
          throw new Error(`Failed to update policy "${spec.name}": ${patchFailure}`)
        }

        if (existing.enabled !== spec.enabled) {
          await policyAction(
            client,
            SENSOR_UPDATE_ENDPOINTS,
            existing.id,
            spec.enabled ? 'enable' : 'disable',
          )
        }
        await syncHostGroups(
          client,
          SENSOR_UPDATE_ENDPOINTS,
          spec.name,
          existing.id,
          spec.hostGroups,
          currentGroupIds(existing),
          entry.prior,
        )
      } else {
        const create: Record<string, unknown> = {
          name: spec.name,
          platform_name: spec.platform,
          settings,
        }
        if (spec.description !== undefined) create.description = spec.description

        const res = await client.request('POST', SENSOR_UPDATE_ENDPOINTS.entity, {
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
        if (spec.enabled) await policyAction(client, SENSOR_UPDATE_ENDPOINTS, created.id, 'enable')
        await syncHostGroups(client, SENSOR_UPDATE_ENDPOINTS, spec.name, created.id, spec.hostGroups, [])
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} sensor update policy(ies) to Falcon tenant at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedPolicies: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Sensor update policy deployment failed after ${deployed.length} of ${specs.length} policy(ies): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedPolicies: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState },
    }
  }
}
