import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildZscalerClient,
  MISSING_CUSTOMER_ID_MESSAGE,
  parseJson,
  zscalerErrorMessage,
  type ZscalerClient,
} from '../../lib/zscaler'
import {
  extractAppConnectorGroupSpecs,
  type AppConnectorGroupSpec,
  type LiveAppConnectorGroup,
} from './validate'

export interface AppConnectorGroupRollbackEntry {
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
    dnsQueryType?: string
    versionProfileId?: string
    cityCountry?: string
  }
}

/**
 * Deploy ZPA App Connector groups via the Zscaler OneAPI.
 *
 * Identity is the NAME (ZPA has no upsert): list /appConnectorGroup, match by
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

  const specs = extractAppConnectorGroupSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: AppConnectorGroupRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    const existing = await listAppConnectorGroups(client)
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
            location: live.location,
            latitude: live.latitude != null ? String(live.latitude) : undefined,
            longitude: live.longitude != null ? String(live.longitude) : undefined,
            countryCode: live.countryCode,
            dnsQueryType: live.dnsQueryType,
            versionProfileId: live.versionProfileId,
            cityCountry: live.cityCountry,
          },
        })
        const res = await client.zpa('PUT', `/appConnectorGroup/${live.id}`, { body: buildPayload(spec, live.id) })
        if (!res.ok) {
          throw new Error(`Failed to update App Connector group "${spec.name}": ${zscalerErrorMessage(res)}`)
        }
      } else {
        const res = await client.zpa('POST', '/appConnectorGroup', { body: buildPayload(spec) })
        if (!res.ok) {
          throw new Error(`Failed to create App Connector group "${spec.name}": ${zscalerErrorMessage(res)}`)
        }
        const created = parseJson<LiveAppConnectorGroup>(res.body)
        if (created?.id == null) {
          throw new Error(`App Connector group "${spec.name}" was created but the API returned no id`)
        }
        rollbackState.push({ name: spec.name, existed: false, id: created.id })
        createdIds.push(created.id)
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} ZPA App Connector group(s) on tenant "${vanity}": ${deployed.join(', ')}`,
      artifacts: { vanity, deployedAppConnectorGroups: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `App Connector group deployment failed after ${deployed.length} of ${specs.length} group(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { vanity, deployedAppConnectorGroups: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** List all ZPA App Connector groups; throws on a non-OK response. */
export async function listAppConnectorGroups(client: ZscalerClient): Promise<LiveAppConnectorGroup[]> {
  const res = await client.zpaGetAll<LiveAppConnectorGroup>('/appConnectorGroup')
  if (!res.ok) {
    throw new Error(
      `Failed to list App Connector groups: ${zscalerErrorMessage({ status: res.status, ok: false, body: res.body })}`,
    )
  }
  return res.items
}

function buildPayload(spec: AppConnectorGroupSpec, id?: string): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    name: spec.name,
    description: spec.description ?? '',
    enabled: spec.enabled,
    location: spec.location,
    latitude: spec.latitude,
    longitude: spec.longitude,
    countryCode: spec.countryCode ?? '',
    dnsQueryType: spec.dnsQueryType,
    versionProfileId: spec.versionProfileId,
    cityCountry: spec.cityCountry ?? '',
  }
  // PUT is replace-style — echo the id back so the record is fully specified.
  if (id != null) payload.id = id
  return payload
}
