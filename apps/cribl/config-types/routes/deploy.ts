import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildCriblUrl, criblConnect, getJson, sendJson, groupResourcePath } from '../../lib/criblApi'
import { itemsFromList, findById, resolveWorkerGroup } from '../../lib/criblCommon'
import { buildRoutesBody, parseRoutes, ROUTES_TABLE_DEFAULT_ID, type CriblRoutingTable } from './_shared'

/**
 * Deploy the Cribl routing table over the REST API:
 *   read (rollback): GET   /api/v1/m/<group>/routes            → find table by id
 *   update:          PATCH /api/v1/m/<group>/routes/<id>       with { id, routes, ... }
 *   create:          POST  /api/v1/m/<group>/routes            with { id, routes, ... }
 *
 * Cribl ships one routing table per group (id "default"), so the table almost
 * always EXISTS and this is an UPDATE — the POST branch is a defensive fallback
 * and Cribl may reject creating a second table. rollbackData records the prior
 * table (null when it did not exist) plus its group so rollback can restore or
 * remove it. Verify against a live Cribl.
 */
async function listTables(base: string, headers: Record<string, string>, group: string): Promise<CriblRoutingTable[]> {
  try {
    return itemsFromList<CriblRoutingTable>(await getJson<unknown>(groupResourcePath(base, group, 'routes'), headers))
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) return { success: false, message: 'Missing credential for routes deployment' }

  const base = buildCriblUrl(component, connectivity, connectivityProvider, Number(settings?.cribl_api_port) || undefined)

  const previous: Array<{ id: string; group: string; table: CriblRoutingTable | null }> = []
  const applied: string[] = []
  const liveByGroup = new Map<string, CriblRoutingTable[]>()

  try {
    const headers = await criblConnect(base, credential)

    for (const item of items) {
      const id = String(item.fields.id ?? '').trim() || ROUTES_TABLE_DEFAULT_ID

      const { routes, extra, error } = parseRoutes(item.fields.routes)
      if (error || !routes) {
        return { success: false, message: `Routing table ${id}: ${error ?? 'invalid routes'}`, artifacts: { applied }, rollbackData: { previous } }
      }

      const group = resolveWorkerGroup(item.fields, settings ?? {})
      if (!liveByGroup.has(group)) liveByGroup.set(group, await listTables(base, headers, group))
      const live = liveByGroup.get(group)!

      const existing = findById(live, id)
      const body = buildRoutesBody(id, routes, extra)

      if (existing) {
        await sendJson('PATCH', `${groupResourcePath(base, group, 'routes')}/${encodeURIComponent(id)}`, headers, body)
        previous.push({ id, group, table: existing })
      } else {
        await sendJson('POST', groupResourcePath(base, group, 'routes'), headers, body)
        previous.push({ id, group, table: null })
      }
      applied.push(group ? `${group}/${id}` : id)
    }

    return {
      success: true,
      message: `Applied ${applied.length} routing table(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Routes deploy failed after ${applied.length} table(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
