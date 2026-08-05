import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildTinesClient, tinesErrorMessage, parseJson, type TinesClient } from '../../lib/tinesApi'
import { buildGlobalResourceBody, extractGlobalResourceSpecs, findGlobalResource, type LiveGlobalResource } from './_shared'

/** Per-resource rollback record captured during deploy. */
export interface GlobalResourceRollbackEntry {
  itemName: string
  name: string
  teamId: string
  existed: boolean
  id?: string
  prior?: LiveGlobalResource
}

/**
 * Deploy Tines Global Resources over the REST API — upsert by (team, name):
 *   read (rollback): GET  /api/v1/global_resources?team_id=
 *   create:          POST /api/v1/global_resources
 *   update:          PUT  /api/v1/global_resources/{id}
 *
 * `folder_name`, when set, is resolved against the team's RESOURCE-type
 * folders (see the Folders config type) — the folder must already exist.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildTinesClient(ctx.component?.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const specs = extractGlobalResourceSpecs(ctx.canvas).filter((s) => s.name && s.teamId && s.value)
  const rollbackState: GlobalResourceRollbackEntry[] = []
  const deployed: string[] = []
  const liveByTeam = new Map<string, LiveGlobalResource[]>()
  const folderCache = new Map<string, string | null>()

  try {
    for (const spec of specs) {
      let live = liveByTeam.get(spec.teamId)
      if (!live) {
        live = await listGlobalResources(client, spec.teamId)
        liveByTeam.set(spec.teamId, live)
      }

      let folderId: string | null = null
      if (spec.folderName) {
        const cacheKey = `${spec.teamId}::${spec.folderName.toLowerCase()}`
        if (folderCache.has(cacheKey)) {
          folderId = folderCache.get(cacheKey) ?? null
        } else {
          folderId = await resolveResourceFolderId(client, spec.teamId, spec.folderName)
          folderCache.set(cacheKey, folderId)
        }
        if (!folderId) {
          throw new Error(
            `Global Resource "${spec.name}": folder "${spec.folderName}" was not found among team ${spec.teamId}'s Resource folders (create it first via the Folders config type).`,
          )
        }
      }

      const match = findGlobalResource(live, spec.teamId, spec.name)
      const body = buildGlobalResourceBody(spec, folderId)

      if (match && match.id !== undefined) {
        rollbackState.push({ itemName: spec.itemName, name: spec.name, teamId: spec.teamId, existed: true, id: String(match.id), prior: match })
        const res = await client.request('PUT', `/global_resources/${match.id}`, { body })
        if (!res.ok) throw new Error(`Failed to update Global Resource "${spec.name}": ${tinesErrorMessage(res)}`)
      } else {
        const res = await client.request('POST', '/global_resources', { body })
        if (!res.ok) throw new Error(`Failed to create Global Resource "${spec.name}": ${tinesErrorMessage(res)}`)
        const created = parseJson<LiveGlobalResource>(res.body)
        if (!created?.id) throw new Error(`Global Resource "${spec.name}" was created but the API returned no id`)
        rollbackState.push({ itemName: spec.itemName, name: spec.name, teamId: spec.teamId, existed: false, id: String(created.id) })
        live.push(created)
      }
      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Applied ${deployed.length} Global Resource(s): ${deployed.join(', ') || '(none)'}`,
      artifacts: { deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Global Resource deploy failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { deployed },
      rollbackData: { previousState: rollbackState },
    }
  }
}

/** List all Global Resources scoped to a team; throws on a non-OK response. */
export async function listGlobalResources(client: TinesClient, teamId: string): Promise<LiveGlobalResource[]> {
  const res = await client.getAll<LiveGlobalResource>('/global_resources', 'global_resources', {
    team_id: teamId,
    include_referencing_action_ids: false,
  })
  if (!res.ok) {
    throw new Error(`Failed to list Global Resources: ${tinesErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  }
  return res.items
}

/** Resolve a RESOURCE-type folder's name to its live id within a team, or null when not found. */
async function resolveResourceFolderId(client: TinesClient, teamId: string, folderName: string): Promise<string | null> {
  const res = await client.getAll<{ id?: number | string; name?: string }>('/folders', 'folders', {
    team_id: teamId,
    content_type: 'RESOURCE',
  })
  if (!res.ok) return null
  const n = folderName.trim().toLowerCase()
  const found = res.items.find((f) => String(f.name ?? '').trim().toLowerCase() === n)
  return found?.id !== undefined ? String(found.id) : null
}
