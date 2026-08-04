import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildGraylogUrl, buildAuthHeader, getJson, sendJson } from '../../lib/graylogApi'
import { asString } from '../../lib/coerce'
import { buildLookupDataAdapterBody, lookupDataAdaptersFromList, findLookupDataAdapter, type GraylogLookupDataAdapter } from './_shared'

/**
 * Deploy Graylog lookup data adapters over the REST API:
 *   read (rollback): GET  /api/system/lookup/adapters       → find the live adapter by name
 *   create:          POST /api/system/lookup/adapters        → DataAdapterApi { id, ... }
 *   update:          PUT  /api/system/lookup/adapters/{name} → DataAdapterApi
 *
 * The adapter NAME is the stable identity used to upsert. PUT addresses the
 * adapter by NAME (not id) for the same reason as lookup-caches — Graylog's
 * checkLookupAdapterId accepts either, and this app never sends an `id` in the
 * body. rollbackData records, per adapter, the prior adapter (null when it did
 * not exist) AND its id — so rollback can restore the prior config (by name) or
 * delete the one we created (by id).
 */
interface LookupDataAdapterCreateResponse {
  id?: string
}

async function listLookupDataAdapters(base: string, headers: Record<string, string>): Promise<GraylogLookupDataAdapter[]> {
  try {
    return lookupDataAdaptersFromList(await getJson<unknown>(`${base}/api/system/lookup/adapters`, headers))
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for lookup-data-adapter deployment' }
  }

  const base = buildGraylogUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const previous: Array<{ name: string; adapterId: string | null; adapter: GraylogLookupDataAdapter | null }> = []
  const applied: string[] = []

  try {
    const live = await listLookupDataAdapters(base, headers)

    for (const item of items) {
      const name = asString(item.fields.name)
      if (!name) continue

      const { body, error } = buildLookupDataAdapterBody(item.fields)
      if (error || !body) throw new Error(`Lookup data adapter "${name}": ${error ?? 'could not build request body'}`)

      const existing = findLookupDataAdapter(live, name)
      if (existing) {
        await sendJson('PUT', `${base}/api/system/lookup/adapters/${encodeURIComponent(name)}`, headers, body)
        previous.push({ name, adapterId: existing.id ?? null, adapter: existing })
      } else {
        const created = await sendJson<LookupDataAdapterCreateResponse>('POST', `${base}/api/system/lookup/adapters`, headers, body)
        previous.push({ name, adapterId: created?.id ?? null, adapter: null })
      }
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} lookup data adapter(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Lookup-data-adapter deploy failed after ${applied.length} adapter(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
