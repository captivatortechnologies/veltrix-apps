import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildGraylogUrl, buildAuthHeader, getJson, sendJson } from '../../lib/graylogApi'
import { asString } from '../../lib/coerce'
import { buildLookupCacheBody, lookupCachesFromList, findLookupCache, type GraylogLookupCache } from './_shared'

/**
 * Deploy Graylog lookup caches over the REST API:
 *   read (rollback): GET  /api/system/lookup/caches       → find the live cache by name
 *   create:          POST /api/system/lookup/caches        → CacheApi { id, ... }
 *   update:          PUT  /api/system/lookup/caches/{name} → CacheApi
 *
 * The cache NAME is the stable identity used to upsert. PUT addresses the cache
 * by NAME (not id) — LookupTableResource.checkLookupCacheId accepts either the
 * id or the name in the URL as long as it equals the body's own id/name, and
 * this app never sends an `id` in the body, so the URL segment must be the
 * name. rollbackData records, per cache, the prior cache (null when it did not
 * exist) AND its id — so rollback can restore the prior config (by name) or
 * delete the one we created (by id).
 */
interface LookupCacheCreateResponse {
  id?: string
}

async function listLookupCaches(base: string, headers: Record<string, string>): Promise<GraylogLookupCache[]> {
  try {
    return lookupCachesFromList(await getJson<unknown>(`${base}/api/system/lookup/caches`, headers))
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for lookup-cache deployment' }
  }

  const base = buildGraylogUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const previous: Array<{ name: string; cacheId: string | null; cache: GraylogLookupCache | null }> = []
  const applied: string[] = []

  try {
    const live = await listLookupCaches(base, headers)

    for (const item of items) {
      const name = asString(item.fields.name)
      if (!name) continue

      const { body, error } = buildLookupCacheBody(item.fields)
      if (error || !body) throw new Error(`Lookup cache "${name}": ${error ?? 'could not build request body'}`)

      const existing = findLookupCache(live, name)
      if (existing) {
        await sendJson('PUT', `${base}/api/system/lookup/caches/${encodeURIComponent(name)}`, headers, body)
        previous.push({ name, cacheId: existing.id ?? null, cache: existing })
      } else {
        const created = await sendJson<LookupCacheCreateResponse>('POST', `${base}/api/system/lookup/caches`, headers, body)
        previous.push({ name, cacheId: created?.id ?? null, cache: null })
      }
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} lookup cache(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Lookup-cache deploy failed after ${applied.length} cache(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
