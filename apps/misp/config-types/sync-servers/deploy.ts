import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildMispUrl, buildAuthHeader, getJson, sendJson } from '../../lib/mispApi'
import { buildServerFields, serversFromList, findServer, type MispServer } from './_shared'

/**
 * Deploy MISP sync servers over the REST API (443):
 *   read (rollback): GET  /servers            → find the live server by url/name
 *   create:          POST /servers/add         with { Server: {...} }
 *   update:          POST /servers/edit/<id>    with { Server: {...} } (server exists)
 *
 * The remote URL is the stable identity used to upsert. rollbackData records, per
 * server, the prior server body (null when it did not exist) AND the server id —
 * so rollback can restore the prior body, or leave a newly created server in place
 * (no simple delete over this seam). The remote authkey is sensitive; it is written
 * but MISP does not read it back, so drift never compares it.
 *
 * NOTE: verify /servers + /servers/add + /servers/edit/<id> against a live MISP 2.4 instance.
 */
interface ServerMutationResponse {
  Server?: MispServer
}

async function listServers(base: string, headers: Record<string, string>): Promise<MispServer[]> {
  try {
    return serversFromList(await getJson<unknown>(`${base}/servers`, headers))
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for sync server deployment' }
  }

  const base = buildMispUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const previous: Array<{ name: string; url: string; serverId: number | string | null; server: MispServer | null }> = []
  const applied: string[] = []

  try {
    const live = await listServers(base, headers)

    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      const url = String(item.fields.url ?? '').trim()
      if (!url && !name) continue

      const existing = findServer(live, url, name)
      const body = { Server: buildServerFields(item.fields) }

      if (existing && existing.id != null) {
        await sendJson('POST', `${base}/servers/edit/${encodeURIComponent(String(existing.id))}`, headers, body)
        previous.push({ name, url, serverId: existing.id, server: existing })
      } else {
        const created = await sendJson<ServerMutationResponse>('POST', `${base}/servers/add`, headers, body)
        const newId = created?.Server?.id ?? null
        previous.push({ name, url, serverId: newId, server: null })
      }
      applied.push(name || url)
    }

    return {
      success: true,
      message: `Applied ${applied.length} sync server(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Sync server deploy failed after ${applied.length} server(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
