import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildGraylogUrl, buildAuthHeader, getJson, sendJson } from '../../lib/graylogApi'
import { asString } from '../../lib/coerce'
import {
  buildLookupTableBody,
  lookupTablesFromList,
  findLookupTable,
  resolveCacheId,
  resolveDataAdapterId,
  type GraylogLookupTable,
} from './_shared'

/**
 * Deploy Graylog lookup tables over the REST API:
 *   resolve: GET /api/system/lookup/caches, GET /api/system/lookup/adapters   → cache/adapter name → id
 *   read (rollback): GET  /api/system/lookup/tables       → find the live table by name
 *   create:          POST /api/system/lookup/tables        → LookupTableApi { id, ... }
 *   update:          PUT  /api/system/lookup/tables/{name} → LookupTableApi
 *
 * The table NAME is the stable identity used to upsert. PUT addresses the table
 * by NAME (not id) for the same reason as lookup-caches/lookup-data-adapters —
 * this app never sends an `id` in the body. An unresolvable cache/adapter name
 * fails that item's deploy loudly. rollbackData records, per table, the prior
 * table (null when it did not exist) AND its id — so rollback can restore the
 * prior config (by name) or delete the one we created (by id).
 */
interface LookupTableCreateResponse {
  id?: string
}

async function listLookupTables(base: string, headers: Record<string, string>): Promise<GraylogLookupTable[]> {
  try {
    return lookupTablesFromList(await getJson<unknown>(`${base}/api/system/lookup/tables`, headers))
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for lookup-table deployment' }
  }

  const base = buildGraylogUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const previous: Array<{ name: string; tableId: string | null; table: GraylogLookupTable | null }> = []
  const applied: string[] = []

  try {
    const live = await listLookupTables(base, headers)

    for (const item of items) {
      const name = asString(item.fields.name)
      if (!name) continue

      const cacheName = asString(item.fields.cache_name)
      const dataAdapterName = asString(item.fields.data_adapter_name)
      const cacheId = await resolveCacheId(base, headers, cacheName)
      if (!cacheId) throw new Error(`Lookup table "${name}": cache "${cacheName}" was not found.`)
      const dataAdapterId = await resolveDataAdapterId(base, headers, dataAdapterName)
      if (!dataAdapterId) throw new Error(`Lookup table "${name}": data adapter "${dataAdapterName}" was not found.`)

      const body = buildLookupTableBody(item.fields, cacheId, dataAdapterId)
      const existing = findLookupTable(live, name)

      if (existing) {
        await sendJson('PUT', `${base}/api/system/lookup/tables/${encodeURIComponent(name)}`, headers, body)
        previous.push({ name, tableId: existing.id ?? null, table: existing })
      } else {
        const created = await sendJson<LookupTableCreateResponse>('POST', `${base}/api/system/lookup/tables`, headers, body)
        previous.push({ name, tableId: created?.id ?? null, table: null })
      }
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} lookup table(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Lookup-table deploy failed after ${applied.length} table(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
