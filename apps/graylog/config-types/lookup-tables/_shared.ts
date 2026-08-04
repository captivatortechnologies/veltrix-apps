// Shared helpers for the Graylog Lookup Tables config type (validate + deploy +
// rollback + drift). Shapes follow the Graylog REST API
// (/api/system/lookup/tables):
//   • POST/PUT body  = LookupTableApi { title, description, name, cache_id,
//                       data_adapter_id, default_single_value,
//                       default_single_value_type, default_multi_value,
//                       default_multi_value_type }
//   • GET  response  = LookupTablePage { lookup_tables: [LookupTableApi] }
// `cache_id`/`data_adapter_id` are resolved from friendlier `cache_name`/
// `data_adapter_name` at deploy time (see resolveCacheId/resolveDataAdapterId
// below) — the same friendliness streams' resolveIndexSetId provides.
// `default_*_value_type` is one of the LookupDefaultValue.Type enum tokens:
// STRING, NUMBER, OBJECT, BOOLEAN, NULL.
// Source: org.graylog2.rest.resources.system.lookup.LookupTableResource,
// org.graylog2.rest.models.system.lookup.LookupTableApi,
// org.graylog2.lookup.LookupDefaultValue (@ 6.1).

import { asString } from '../../lib/coerce'
import { getJson } from '../../lib/graylogApi'

/** Valid `default_*_value_type` tokens (LookupDefaultValue.Type). */
export const DEFAULT_VALUE_TYPES = new Set(['STRING', 'NUMBER', 'OBJECT', 'BOOLEAN', 'NULL'])

/** One lookup table as returned by GET /api/system/lookup/tables (LookupTableApi). */
export interface GraylogLookupTable {
  id?: string
  title?: string
  description?: string
  name?: string
  cache_id?: string
  data_adapter_id?: string
  default_single_value?: string
  default_single_value_type?: string
  default_multi_value?: string
  default_multi_value_type?: string
  content_pack?: string
  [key: string]: unknown
}

/** GET /api/system/lookup/tables envelope: `{ lookup_tables: [...] }`. */
interface LookupTablePageResponse {
  lookup_tables?: GraylogLookupTable[]
}

interface NamedRef {
  id?: string
  name?: string
}
interface CachesPageResponse {
  caches?: NamedRef[]
}
interface DataAdapterPageResponse {
  data_adapters?: NamedRef[]
}

/** Body sent to POST/PUT /api/system/lookup/tables[/{idOrName}]. */
export interface LookupTableBody {
  title: string
  description: string
  name: string
  cache_id: string
  data_adapter_id: string
  default_single_value: string
  default_single_value_type: string
  default_multi_value: string
  default_multi_value_type: string
}

/** Unwrap GET /api/system/lookup/tables into a flat array of tables. */
export function lookupTablesFromList(list: unknown): GraylogLookupTable[] {
  if (Array.isArray(list)) return list as GraylogLookupTable[]
  const tables = (list as LookupTablePageResponse | null)?.lookup_tables
  return Array.isArray(tables) ? tables : []
}

/** Find a live lookup table by name (the stable identity used for upsert + drift). */
export function findLookupTable(tables: GraylogLookupTable[], name: string): GraylogLookupTable | null {
  const n = asString(name)
  if (!n) return null
  return tables.find((t) => asString(t.name) === n) ?? null
}

/** Resolve a lookup-cache name to its id via GET /api/system/lookup/caches. Returns '' if not found. */
export async function resolveCacheId(base: string, headers: Record<string, string>, name: string): Promise<string> {
  const n = asString(name)
  if (!n) return ''
  try {
    const res = await getJson<CachesPageResponse>(`${base}/api/system/lookup/caches`, headers)
    return asString((res.caches ?? []).find((c) => asString(c.name) === n)?.id)
  } catch {
    return ''
  }
}

/** Resolve a data-adapter name to its id via GET /api/system/lookup/adapters. Returns '' if not found. */
export async function resolveDataAdapterId(base: string, headers: Record<string, string>, name: string): Promise<string> {
  const n = asString(name)
  if (!n) return ''
  try {
    const res = await getJson<DataAdapterPageResponse>(`${base}/api/system/lookup/adapters`, headers)
    return asString((res.data_adapters ?? []).find((a) => asString(a.name) === n)?.id)
  } catch {
    return ''
  }
}

/** Normalize a default-value-type token (defaults to NULL when unrecognized). */
export function normalizeDefaultValueType(value: unknown): string {
  const s = asString(value).toUpperCase()
  return DEFAULT_VALUE_TYPES.has(s) ? s : 'NULL'
}

/** Build the LookupTableApi body from canvas fields + resolved cache/adapter ids. */
export function buildLookupTableBody(fields: Record<string, unknown>, cacheId: string, dataAdapterId: string): LookupTableBody {
  return {
    title: asString(fields.title),
    description: asString(fields.description),
    name: asString(fields.name),
    cache_id: cacheId,
    data_adapter_id: dataAdapterId,
    default_single_value: asString(fields.default_single_value),
    default_single_value_type: normalizeDefaultValueType(fields.default_single_value_type),
    default_multi_value: asString(fields.default_multi_value),
    default_multi_value_type: normalizeDefaultValueType(fields.default_multi_value_type),
  }
}

/** Build a restore body from a live lookup table (rollback) — the summary is a valid PUT body. */
export function bodyFromLiveLookupTable(table: GraylogLookupTable): LookupTableBody {
  return {
    title: asString(table.title),
    description: asString(table.description),
    name: asString(table.name),
    cache_id: asString(table.cache_id),
    data_adapter_id: asString(table.data_adapter_id),
    default_single_value: asString(table.default_single_value),
    default_single_value_type: normalizeDefaultValueType(table.default_single_value_type),
    default_multi_value: asString(table.default_multi_value),
    default_multi_value_type: normalizeDefaultValueType(table.default_multi_value_type),
  }
}
