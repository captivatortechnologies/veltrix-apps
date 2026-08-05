import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildTinesClient, tinesErrorMessage, parseJson, type TinesClient } from '../../lib/tinesApi'
import { buildCredentialBody, extractCredentialSpecs, findCredential, type LiveCredential } from './_shared'

/** Per-credential rollback record captured during deploy. Never carries secret material — Tines never returns it. */
export interface CredentialRollbackEntry {
  itemName: string
  name: string
  teamId: string
  existed: boolean
  id?: string
  prior?: LiveCredential
}

/**
 * Deploy Tines Credential METADATA over the REST API — upsert by (team,
 * name):
 *   read (rollback): GET  /api/v1/user_credentials?team_id=
 *   create:          POST /api/v1/user_credentials
 *   update:          PUT  /api/v1/user_credentials/{id}
 *
 * `folder_name`, when set, is resolved against the team's CREDENTIAL-type
 * folders (see the Folders config type) — the folder must already exist.
 * Secret material is sent when the operator supplied it and otherwise
 * omitted entirely (Tines keeps an existing secret unchanged when its field
 * is absent from the update body).
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildTinesClient(ctx.component?.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const specs = extractCredentialSpecs(ctx.canvas).filter((s) => s.name && s.teamId && s.mode)
  const rollbackState: CredentialRollbackEntry[] = []
  const deployed: string[] = []
  const liveByTeam = new Map<string, LiveCredential[]>()
  const folderCache = new Map<string, string | null>()

  try {
    for (const spec of specs) {
      let live = liveByTeam.get(spec.teamId)
      if (!live) {
        live = await listCredentials(client, spec.teamId)
        liveByTeam.set(spec.teamId, live)
      }

      let folderId: string | null = null
      if (spec.folderName) {
        const cacheKey = `${spec.teamId}::${spec.folderName.toLowerCase()}`
        if (folderCache.has(cacheKey)) {
          folderId = folderCache.get(cacheKey) ?? null
        } else {
          folderId = await resolveCredentialFolderId(client, spec.teamId, spec.folderName)
          folderCache.set(cacheKey, folderId)
        }
        if (!folderId) {
          throw new Error(
            `Credential "${spec.name}": folder "${spec.folderName}" was not found among team ${spec.teamId}'s Credential folders (create it first via the Folders config type).`,
          )
        }
      }

      const match = findCredential(live, spec.teamId, spec.name)
      const body = buildCredentialBody(spec, folderId)

      if (match && match.id !== undefined) {
        rollbackState.push({ itemName: spec.itemName, name: spec.name, teamId: spec.teamId, existed: true, id: String(match.id), prior: match })
        const res = await client.request('PUT', `/user_credentials/${match.id}`, { body })
        if (!res.ok) throw new Error(`Failed to update credential "${spec.name}": ${tinesErrorMessage(res)}`)
      } else {
        const res = await client.request('POST', '/user_credentials', { body })
        if (!res.ok) throw new Error(`Failed to create credential "${spec.name}": ${tinesErrorMessage(res)}`)
        const created = parseJson<LiveCredential>(res.body)
        if (!created?.id) throw new Error(`Credential "${spec.name}" was created but the API returned no id`)
        rollbackState.push({ itemName: spec.itemName, name: spec.name, teamId: spec.teamId, existed: false, id: String(created.id) })
        live.push(created)
      }
      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Applied ${deployed.length} credential(s): ${deployed.join(', ') || '(none)'}`,
      artifacts: { deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Credential deploy failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { deployed },
      rollbackData: { previousState: rollbackState },
    }
  }
}

/** List all credentials scoped to a team; throws on a non-OK response. Never carries secret material. */
export async function listCredentials(client: TinesClient, teamId: string): Promise<LiveCredential[]> {
  const res = await client.getAll<LiveCredential>('/user_credentials', 'user_credentials', { team_id: teamId })
  if (!res.ok) {
    throw new Error(`Failed to list credentials: ${tinesErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  }
  return res.items
}

/** Resolve a CREDENTIAL-type folder's name to its live id within a team, or null when not found. */
async function resolveCredentialFolderId(client: TinesClient, teamId: string, folderName: string): Promise<string | null> {
  const res = await client.getAll<{ id?: number | string; name?: string }>('/folders', 'folders', {
    team_id: teamId,
    content_type: 'CREDENTIAL',
  })
  if (!res.ok) return null
  const n = folderName.trim().toLowerCase()
  const found = res.items.find((f) => String(f.name ?? '').trim().toLowerCase() === n)
  return found?.id !== undefined ? String(found.id) : null
}
