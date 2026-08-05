import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildTinesClient, tinesErrorMessage, parseJson, type TinesClient } from '../../lib/tinesApi'
import { buildFolderBody, extractFolderSpecs, findFolder, findFolderByName, type FolderSpec, type LiveFolder } from './_shared'

/** Per-folder rollback record captured during deploy. */
export interface FolderRollbackEntry {
  itemName: string
  name: string
  existed: boolean
  id?: string
  prior?: LiveFolder
}

/**
 * Deploy Tines folders over the REST API — upsert scoped by (team, content
 * type, parent, name):
 *   read (rollback): GET  /api/v1/folders?team_id=&content_type=
 *   create:          POST /api/v1/folders   <- { name, content_type, team_id, parent_folder_id }
 *   update:          PUT  /api/v1/folders/{id}  <- { name, parent_folder_id }
 *
 * Two passes so a parent declared earlier in the SAME canvas resolves before
 * its children are applied: pass 1 deploys every folder with no declared
 * parent; pass 2 deploys folders WITH a parent, resolving it from pass 1's
 * newly-created folders or the live tenant. Deeper nesting (grandchild in the
 * same deploy) is not resolved — deploy the parent level first.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildTinesClient(ctx.component?.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const specs = extractFolderSpecs(ctx.canvas).filter((s) => s.name && s.teamId && s.contentType)
  const rollbackState: FolderRollbackEntry[] = []
  const deployed: string[] = []
  // key: teamId::contentType::name -> live folder id, populated as we go
  const createdByScope = new Map<string, string>()

  const scopeKey = (teamId: string, contentType: string, name: string) => `${teamId}::${contentType}::${name.toLowerCase()}`

  try {
    const liveByScope = new Map<string, LiveFolder[]>()
    const liveFor = async (teamId: string, contentType: string): Promise<LiveFolder[]> => {
      const key = `${teamId}::${contentType}`
      if (!liveByScope.has(key)) liveByScope.set(key, await listFolders(client, teamId, contentType))
      return liveByScope.get(key) as LiveFolder[]
    }

    const rootFirst = [...specs].sort((a, b) => (a.parentFolderName ? 1 : 0) - (b.parentFolderName ? 1 : 0))

    for (const spec of rootFirst) {
      const parentId = await resolveParentId(client, spec, liveFor, createdByScope)
      if (spec.parentFolderName && parentId === null) {
        throw new Error(
          `Folder "${spec.name}": parent folder "${spec.parentFolderName}" was not found in team ${spec.teamId} / ${spec.contentType} (create it first, or declare it earlier in this canvas).`,
        )
      }

      const live = await liveFor(spec.teamId, spec.contentType)
      const match = findFolder(live, spec, parentId)
      const body = buildFolderBody(spec, parentId)

      if (match && match.id !== undefined) {
        rollbackState.push({ itemName: spec.itemName, name: spec.name, existed: true, id: String(match.id), prior: match })
        const res = await client.request('PUT', `/folders/${match.id}`, { body: { name: body.name, parent_folder_id: body.parent_folder_id } })
        if (!res.ok) throw new Error(`Failed to update folder "${spec.name}": ${tinesErrorMessage(res)}`)
        createdByScope.set(scopeKey(spec.teamId, spec.contentType, spec.name), String(match.id))
      } else {
        const res = await client.request('POST', '/folders', { body })
        if (!res.ok) throw new Error(`Failed to create folder "${spec.name}": ${tinesErrorMessage(res)}`)
        const created = parseJson<LiveFolder>(res.body)
        if (!created?.id) throw new Error(`Folder "${spec.name}" was created but the API returned no id`)
        rollbackState.push({ itemName: spec.itemName, name: spec.name, existed: false, id: String(created.id) })
        createdByScope.set(scopeKey(spec.teamId, spec.contentType, spec.name), String(created.id))
        live.push(created)
      }
      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Applied ${deployed.length} folder(s): ${deployed.join(', ') || '(none)'}`,
      artifacts: { deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Folder deploy failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { deployed },
      rollbackData: { previousState: rollbackState },
    }
  }
}

/** Resolve a spec's parent_folder_name to a live id, or null when it has none. */
async function resolveParentId(
  client: TinesClient,
  spec: FolderSpec,
  liveFor: (teamId: string, contentType: string) => Promise<LiveFolder[]>,
  createdByScope: Map<string, string>,
): Promise<string | null> {
  if (!spec.parentFolderName) return null
  const key = `${spec.teamId}::${spec.contentType}::${spec.parentFolderName.toLowerCase()}`
  const fromThisDeploy = createdByScope.get(key)
  if (fromThisDeploy) return fromThisDeploy

  const live = await liveFor(spec.teamId, spec.contentType)
  const found = findFolderByName(live, spec.teamId, spec.contentType, spec.parentFolderName)
  return found?.id !== undefined ? String(found.id) : null
}

/** List all folders for a (team, content type) scope; throws on a non-OK response. */
export async function listFolders(client: TinesClient, teamId: string, contentType: string): Promise<LiveFolder[]> {
  const res = await client.getAll<LiveFolder>('/folders', 'folders', { team_id: teamId, content_type: contentType })
  if (!res.ok) {
    throw new Error(`Failed to list folders: ${tinesErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  }
  return res.items
}
