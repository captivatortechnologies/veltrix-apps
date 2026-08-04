// Shared helpers for the Graylog Lookup Caches config type (validate + deploy +
// rollback + drift). Shapes follow the Graylog REST API
// (/api/system/lookup/caches):
//   • POST/PUT body  = CacheApi { title, description, name, config }
//   • GET  response  = CachesPage { caches: [CacheApi] }
// `config` is a typed, discriminated blob — `config.type` selects the cache
// implementation and its own fields, e.g.:
//   • "guava_cache" (CaffeineLookupCache.Config) — { max_size, expire_after_access,
//     expire_after_access_unit, expire_after_write, expire_after_write_unit }
//   • "none" (NullCache.Config) — {} (no caching; every lookup hits the adapter)
// Source: org.graylog2.rest.resources.system.lookup.LookupTableResource,
// org.graylog2.rest.models.system.lookup.CacheApi,
// org.graylog2.lookup.caches.{CaffeineLookupCache,NullCache} (@ 6.1).

import { asString, parseJsonObject } from '../../lib/coerce'

/** One lookup cache as returned by GET /api/system/lookup/caches (CacheApi). */
export interface GraylogLookupCache {
  id?: string
  title?: string
  description?: string
  name?: string
  config?: Record<string, unknown>
  content_pack?: string
  [key: string]: unknown
}

/** GET /api/system/lookup/caches envelope: `{ caches: [...] }`. */
interface CachesPageResponse {
  caches?: GraylogLookupCache[]
}

/** Body sent to POST/PUT /api/system/lookup/caches[/{idOrName}]. */
export interface LookupCacheBody {
  title: string
  description: string
  name: string
  config: Record<string, unknown>
}

/** Unwrap GET /api/system/lookup/caches into a flat array of caches. */
export function lookupCachesFromList(list: unknown): GraylogLookupCache[] {
  if (Array.isArray(list)) return list as GraylogLookupCache[]
  const caches = (list as CachesPageResponse | null)?.caches
  return Array.isArray(caches) ? caches : []
}

/** Find a live cache by name (the stable identity used for upsert + drift). */
export function findLookupCache(caches: GraylogLookupCache[], name: string): GraylogLookupCache | null {
  const n = asString(name)
  if (!n) return null
  return caches.find((c) => asString(c.name) === n) ?? null
}

export interface BuiltLookupCacheBody {
  body?: LookupCacheBody
  error?: string
}

/** Build the CacheApi body from canvas fields. */
export function buildLookupCacheBody(fields: Record<string, unknown>): BuiltLookupCacheBody {
  const { value: config, error } = parseJsonObject(fields.config)
  if (error) return { error: `config ${error}` }
  if (!asString(config.type)) return { error: 'config.type is required (e.g. "guava_cache" or "none")' }
  return {
    body: {
      title: asString(fields.title),
      description: asString(fields.description),
      name: asString(fields.name),
      config,
    },
  }
}

/** Build a restore body from a live cache (rollback). */
export function bodyFromLiveLookupCache(cache: GraylogLookupCache): LookupCacheBody {
  return {
    title: asString(cache.title),
    description: asString(cache.description),
    name: asString(cache.name),
    config: (cache.config && typeof cache.config === 'object' ? cache.config : {}) as Record<string, unknown>,
  }
}
