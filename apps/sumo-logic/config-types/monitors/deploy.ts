import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildBaseUrl, buildAuthHeader, hasBasicAuth, getJson, sendJson } from '../../lib/sumoLogicApi'
import {
  buildMonitorCreateBody,
  buildMonitorUpdateBody,
  findMonitorChild,
  type Monitor,
  type MonitorsLibraryFolderResponse,
} from './_shared'

/**
 * Deploy Sumo Logic Monitors over the Management API (HTTPS). Unlike every
 * other config type in this app, there is no plain "list all" endpoint —
 * monitors are discovered per PARENT FOLDER:
 *   resolve root:  GET  /monitors/root                          → root folder id (when parentId is blank)
 *   read folder:   GET  /monitors/<parentId>                    → { children: [...] } (cached per folder within this deploy)
 *   read monitor:  GET  /monitors/<id>                          → full body (captured for rollback + version)
 *   create:        POST /monitors?parentId=<parentId>           with { type: 'MonitorsLibraryMonitor', ... }
 *   update:        PUT  /monitors/<id>                          with the full body + the CURRENT live `version`
 *
 * The monitor NAME is the stable identity used to upsert, scoped to its parent
 * folder (Sumo Logic only enforces name-uniqueness per folder). rollbackData
 * records, per monitor, the prior full body (null when it did not exist) AND
 * the monitor id — so rollback can restore the prior body (against whatever
 * version is live AT ROLLBACK TIME — Sumo Logic's update is optimistic-
 * concurrency versioned) or bulk-delete the ones we created.
 *
 * API: https://help.sumologic.com/docs/api/monitors/
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!hasBasicAuth(credential)) {
    return { success: false, message: 'Missing Access ID / Access Key credential for monitor deployment' }
  }

  const base = buildBaseUrl(component, connectivity)
  const headers = buildAuthHeader(credential!)

  const previous: Array<{ name: string; monitorId: string | null; monitor: Monitor | null }> = []
  const applied: string[] = []

  let rootId: string | null = null
  const folderCache = new Map<string, MonitorsLibraryFolderResponse | null>()

  async function resolveParentId(declared: string): Promise<string> {
    if (declared) return declared
    if (rootId) return rootId
    const root = await getJson<{ id: string }>(`${base}/monitors/root`, headers)
    rootId = root.id
    return rootId
  }

  async function readFolder(parentId: string): Promise<MonitorsLibraryFolderResponse | null> {
    if (folderCache.has(parentId)) return folderCache.get(parentId)!
    try {
      const folder = await getJson<MonitorsLibraryFolderResponse>(`${base}/monitors/${encodeURIComponent(parentId)}`, headers)
      folderCache.set(parentId, folder)
      return folder
    } catch {
      folderCache.set(parentId, null)
      return null
    }
  }

  try {
    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue

      const parentId = await resolveParentId(String(item.fields.parentId ?? '').trim())
      const folder = await readFolder(parentId)
      const match = findMonitorChild(folder?.children, name)

      if (match) {
        const fullExisting = await getJson<Monitor>(`${base}/monitors/${encodeURIComponent(match.id)}`, headers)
        const body = buildMonitorUpdateBody(item.fields, fullExisting.version ?? match.version)
        await sendJson('PUT', `${base}/monitors/${encodeURIComponent(match.id)}`, headers, body)
        previous.push({ name, monitorId: match.id, monitor: fullExisting })
      } else {
        const body = buildMonitorCreateBody(item.fields)
        const created = await sendJson<{ id: string }>('POST', `${base}/monitors?parentId=${encodeURIComponent(parentId)}`, headers, body)
        previous.push({ name, monitorId: created?.id ?? null, monitor: null })
      }
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} monitor(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Monitor deploy failed after ${applied.length} monitor(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
