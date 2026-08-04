import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildJamfClient, type JamfClient } from '../../lib/jamfApi'
import { buildBuildingBody, buildingKey, extractBuildingSpecs, indexBuildingsByName, type LiveBuilding } from './validate'

const BUILDINGS_PATH = '/v1/buildings'

export interface BuildingRollbackEntry {
  key: string
  label: string
  existed: boolean
  id?: string
  prior?: LiveBuilding
}

interface CreateBuildingResponse {
  id?: string
}

/**
 * Deploy Jamf Pro buildings via the modern Jamf Pro API
 * (https://developer.jamf.com/jamf-pro/reference/get_v1-buildings,
 * post_v1-buildings, put_v1-buildings-id). Identity is the building `name`.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildJamfClient(ctx.component, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, apiBase } = built

  const specs = extractBuildingSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: BuildingRollbackEntry[] = []
  const createdIds: string[] = []
  const created: string[] = []
  const updated: string[] = []

  try {
    const existing = await listBuildings(client, ctx.settings)
    const byName = indexBuildingsByName(existing)

    for (const spec of specs) {
      const label = spec.name
      const key = buildingKey(spec.name)
      const live = byName.get(key)
      const body = buildBuildingBody(spec)

      if (live && live.id) {
        rollbackState.push({ key, label, existed: true, id: live.id, prior: live })
        const res = await client.request('PUT', `${BUILDINGS_PATH}/${encodeURIComponent(live.id)}`, body)
        if (res.error) throw new Error(`Failed to update building "${label}": ${res.error}`)
        updated.push(label)
      } else {
        const res = await client.request<CreateBuildingResponse>('POST', BUILDINGS_PATH, body)
        if (res.error) throw new Error(`Failed to create building "${label}": ${res.error}`)
        const id = res.data?.id
        if (!id) throw new Error(`Building "${label}" was created but Jamf Pro returned no id`)
        rollbackState.push({ key, label, existed: false, id })
        createdIds.push(id)
        created.push(label)
      }
    }

    return {
      success: true,
      message: `Reconciled ${specs.length} Jamf Pro building(s) on ${apiBase}: ${created.length} created, ${updated.length} updated.`,
      artifacts: { apiBase, createdBuildings: created, updatedBuildings: updated },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Building deployment failed after ${created.length + updated.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { apiBase, createdBuildings: created, updatedBuildings: updated },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

export async function listBuildings(client: JamfClient, settings: Record<string, unknown>): Promise<LiveBuilding[]> {
  const pageSize = typeof settings.page_size === 'number' && settings.page_size > 0 ? settings.page_size : 100
  const res = await client.listAll<LiveBuilding>(BUILDINGS_PATH, pageSize)
  if (res.error) throw new Error(`Failed to list Jamf Pro buildings: ${res.error}`)
  return res.nodes
}
