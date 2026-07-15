import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildZscalerClient,
  MISSING_CUSTOMER_ID_MESSAGE,
  parseJson,
  zscalerErrorMessage,
  type ZscalerClient,
} from '../../lib/zscaler'
import { extractServiceEdgeGroupSpecs, type LiveServiceEdgeGroup, type ServiceEdgeGroupSpec } from './validate'

export interface ServiceEdgeGroupRollbackEntry {
  name: string
  existed: boolean
  id?: string
  prior?: {
    name?: string
    description?: string
    enabled?: boolean
    location?: string
    latitude?: string
    longitude?: string
    countryCode?: string
    versionProfileId?: string
    upgradeDay?: string
    upgradeTimeInSecs?: string
  }
}

/**
 * Deploy ZPA service edge groups via the Zscaler OneAPI.
 *
 * Identity is the NAME (ZPA has no upsert): list /serviceEdgeGroup, match by
 * name, then PUT an existing group or POST a new one. Unlike ZIA, ZPA changes
 * apply IMMEDIATELY — there is no activation step, so a write returning success
 * is the end of the operation.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, vanity } = built
  if (!client.hasCustomerId) {
    return { success: false, message: MISSING_CUSTOMER_ID_MESSAGE }
  }

  const specs = extractServiceEdgeGroupSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: ServiceEdgeGroupRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    const existing = await listServiceEdgeGroups(client)
    const byName = new Map(existing.filter((g) => g.name).map((g) => [g.name as string, g]))

    for (const spec of specs) {
      const live = byName.get(spec.name)

      if (live && live.id != null) {
        rollbackState.push({
          name: spec.name,
          existed: true,
          id: live.id,
          prior: {
            name: live.name,
            description: live.description ?? '',
            enabled: live.enabled ?? true,
            location: live.location ?? '',
            latitude: live.latitude ?? '',
            longitude: live.longitude ?? '',
            countryCode: live.countryCode ?? '',
            versionProfileId: live.versionProfileId ?? '0',
            upgradeDay: live.upgradeDay ?? 'SUNDAY',
            upgradeTimeInSecs: live.upgradeTimeInSecs ?? '66600',
          },
        })
        const res = await client.zpa('PUT', `/serviceEdgeGroup/${live.id}`, { body: buildPayload(spec, live.id) })
        if (!res.ok) {
          throw new Error(`Failed to update service edge group "${spec.name}": ${zscalerErrorMessage(res)}`)
        }
      } else {
        const res = await client.zpa('POST', '/serviceEdgeGroup', { body: buildPayload(spec) })
        if (!res.ok) {
          throw new Error(`Failed to create service edge group "${spec.name}": ${zscalerErrorMessage(res)}`)
        }
        const created = parseJson<LiveServiceEdgeGroup>(res.body)
        if (created?.id == null) {
          throw new Error(`Service edge group "${spec.name}" was created but the API returned no id`)
        }
        rollbackState.push({ name: spec.name, existed: false, id: created.id })
        createdIds.push(created.id)
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} ZPA service edge group(s) on tenant "${vanity}": ${deployed.join(', ')}`,
      artifacts: { vanity, deployedServiceEdgeGroups: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Service edge group deployment failed after ${deployed.length} of ${specs.length} group(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { vanity, deployedServiceEdgeGroups: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** List all ZPA service edge groups; throws on a non-OK response. */
export async function listServiceEdgeGroups(client: ZscalerClient): Promise<LiveServiceEdgeGroup[]> {
  const res = await client.zpaGetAll<LiveServiceEdgeGroup>('/serviceEdgeGroup')
  if (!res.ok) {
    throw new Error(
      `Failed to list service edge groups: ${zscalerErrorMessage({ status: res.status, ok: false, body: res.body })}`,
    )
  }
  return res.items
}

function buildPayload(spec: ServiceEdgeGroupSpec, id?: string): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    name: spec.name,
    description: spec.description ?? '',
    enabled: spec.enabled,
    location: spec.location,
    // ZPA expects latitude/longitude as strings.
    latitude: spec.latitude,
    longitude: spec.longitude,
    countryCode: spec.countryCode ?? '',
    versionProfileId: spec.versionProfileId,
    upgradeDay: spec.upgradeDay,
    upgradeTimeInSecs: spec.upgradeTimeInSecs,
  }
  // PUT is replace-style — echo the id back so the record is fully specified.
  if (id != null) payload.id = id
  return payload
}
