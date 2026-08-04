// Shared helpers for the Graylog Lookup Data Adapters config type (validate +
// deploy + rollback + drift). Shapes follow the Graylog REST API
// (/api/system/lookup/adapters):
//   • POST/PUT body  = DataAdapterApi { title, description, name, config,
//                       custom_error_ttl_enabled?, custom_error_ttl?,
//                       custom_error_ttl_unit? }
//   • GET  response  = DataAdapterPage { data_adapters: [DataAdapterApi] }
// `config` is a typed, discriminated blob — `config.type` selects the adapter
// implementation and its own fields, e.g. "csvfile" (CSVFileDataAdapter),
// "dnslookup" (DnsLookupDataAdapter), "httpjsonpath" (HTTPJSONPathDataAdapter).
// Source: org.graylog2.rest.resources.system.lookup.LookupTableResource,
// org.graylog2.rest.models.system.lookup.DataAdapterApi (@ 6.1).

import { asString, toBool, toInt, parseJsonObject } from '../../lib/coerce'

/** One data adapter as returned by GET /api/system/lookup/adapters (DataAdapterApi). */
export interface GraylogLookupDataAdapter {
  id?: string
  title?: string
  description?: string
  name?: string
  config?: Record<string, unknown>
  custom_error_ttl_enabled?: boolean
  custom_error_ttl?: number
  custom_error_ttl_unit?: string
  content_pack?: string
  [key: string]: unknown
}

/** GET /api/system/lookup/adapters envelope: `{ data_adapters: [...] }`. */
interface DataAdapterPageResponse {
  data_adapters?: GraylogLookupDataAdapter[]
}

/** Body sent to POST/PUT /api/system/lookup/adapters[/{idOrName}]. */
export interface LookupDataAdapterBody {
  title: string
  description: string
  name: string
  config: Record<string, unknown>
  custom_error_ttl_enabled?: boolean
  custom_error_ttl?: number
  custom_error_ttl_unit?: string
}

/** Unwrap GET /api/system/lookup/adapters into a flat array of adapters. */
export function lookupDataAdaptersFromList(list: unknown): GraylogLookupDataAdapter[] {
  if (Array.isArray(list)) return list as GraylogLookupDataAdapter[]
  const adapters = (list as DataAdapterPageResponse | null)?.data_adapters
  return Array.isArray(adapters) ? adapters : []
}

/** Find a live data adapter by name (the stable identity used for upsert + drift). */
export function findLookupDataAdapter(adapters: GraylogLookupDataAdapter[], name: string): GraylogLookupDataAdapter | null {
  const n = asString(name)
  if (!n) return null
  return adapters.find((a) => asString(a.name) === n) ?? null
}

export interface BuiltLookupDataAdapterBody {
  body?: LookupDataAdapterBody
  error?: string
}

/** Build the DataAdapterApi body from canvas fields. */
export function buildLookupDataAdapterBody(fields: Record<string, unknown>): BuiltLookupDataAdapterBody {
  const { value: config, error } = parseJsonObject(fields.config)
  if (error) return { error: `config ${error}` }
  if (!asString(config.type)) return { error: 'config.type is required (e.g. "csvfile", "dnslookup", "httpjsonpath")' }

  const body: LookupDataAdapterBody = {
    title: asString(fields.title),
    description: asString(fields.description),
    name: asString(fields.name),
    config,
  }
  if (toBool(fields.custom_error_ttl_enabled)) {
    body.custom_error_ttl_enabled = true
    body.custom_error_ttl = toInt(fields.custom_error_ttl, 60)
    body.custom_error_ttl_unit = asString(fields.custom_error_ttl_unit) || 'SECONDS'
  }
  return { body }
}

/** Build a restore body from a live data adapter (rollback). */
export function bodyFromLiveLookupDataAdapter(adapter: GraylogLookupDataAdapter): LookupDataAdapterBody {
  const body: LookupDataAdapterBody = {
    title: asString(adapter.title),
    description: asString(adapter.description),
    name: asString(adapter.name),
    config: (adapter.config && typeof adapter.config === 'object' ? adapter.config : {}) as Record<string, unknown>,
  }
  if (adapter.custom_error_ttl_enabled) {
    body.custom_error_ttl_enabled = true
    body.custom_error_ttl = adapter.custom_error_ttl
    body.custom_error_ttl_unit = adapter.custom_error_ttl_unit
  }
  return body
}
