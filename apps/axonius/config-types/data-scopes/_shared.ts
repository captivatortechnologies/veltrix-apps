// Shared helpers for the Axonius Data Scopes config type (deploy + rollback +
// drift + validate). A data scope is a named set of asset-scope saved queries
// (devices and/or users) that a role can be restricted to see — Axonius's
// row-level-security primitive. Requires the Data Scopes feature to be enabled
// on the tenant (Enterprise). Shapes follow the axonius-api-client JSON:API
// surface; verify against a live Axonius tenant.
//
// Endpoints (verified against axonius_api_client master — api_endpoints.py,
// json_api/data_scopes.py):
//   GET    api/settings/data_scope         one document: { scopes: [...], settings } —
//                                           NOT a JSON:API list; `scopes` is a plain array
//   POST   api/settings/data_scope         create (type_ data_scope_request_schema)
//   PUT    api/settings/data_scope/{uuid}  update (type_ data_scope_request_schema,
//                                           uuid carried in the body AND the path)
//   DELETE api/settings/data_scope/{uuid}  delete — no request body

import { SAVED_QUERIES_LIST_RESOURCE, savedQueriesFromResponse, type AxoniusSavedQuery } from '../saved-queries/_shared'

/** JSON:API resource type for the create/update body (data_scope_request_schema). */
const DATA_SCOPE_SCHEMA_TYPE = 'data_scope_request_schema'

// --- Endpoint resource paths (relative to the API root, e.g. `api/`) ----------

/** GET — the one Data Scopes document (`scopes` + `settings`). */
export const DATA_SCOPES_RESOURCE = 'settings/data_scope'
/** POST — create a data scope. */
export const CREATE_DATA_SCOPE_RESOURCE = 'settings/data_scope'
/** PUT — update a data scope by uuid. */
export function updateDataScopeResource(uuid: string): string {
  return `settings/data_scope/${encodeURIComponent(uuid)}`
}
/** DELETE — remove a data scope by uuid (no request body). */
export function deleteDataScopeResource(uuid: string): string {
  return `settings/data_scope/${encodeURIComponent(uuid)}`
}

// --- Types ----------------------------------------------------------------

/** One data scope, as returned inside the `scopes` array of the GET document. */
export interface AxoniusDataScope {
  uuid?: string
  name?: string
  description?: string
  devices_queries?: string[]
  users_queries?: string[]
  associated_roles?: string[]
  [key: string]: unknown
}

// --- Field parsing ----------------------------------------------------------

/** Trim a string canvas value. */
export function parseText(value: unknown): string {
  return String(value ?? '').trim()
}

/**
 * Parse a `tags`-field canvas value (array or comma/newline string) into a
 * clean, deduped list of names, preserving order.
 */
export function parseNameList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value.map((v) => String(v ?? '')) : String(value ?? '').split(/[\n,]/)
  const out: string[] = []
  for (const entry of raw) {
    const name = entry.trim()
    if (name && !out.includes(name)) out.push(name)
  }
  return out
}

// --- Saved-query name → uuid resolution (reuses the saved-queries config type) --

/** Read every live saved query (best-effort), for resolving devices/users query names to uuids. */
export async function listSavedQueriesForScopes(
  getJsonFn: (resource: string) => Promise<unknown>,
): Promise<AxoniusSavedQuery[]> {
  try {
    return savedQueriesFromResponse(await getJsonFn(SAVED_QUERIES_LIST_RESOURCE))
  } catch {
    return []
  }
}

/**
 * Resolve a list of saved-query names to their uuids within one asset module.
 * Throws with a clear, actionable message on the first unresolved name — a data
 * scope referencing a saved query that doesn't exist would otherwise fail
 * confusingly deep inside the Axonius API.
 */
export function resolveQueryNames(names: string[], live: AxoniusSavedQuery[], module: 'devices' | 'users'): string[] {
  const uuids: string[] = []
  for (const name of names) {
    const match = live.find((sq) => {
      const sqModule = String(sq.module ?? '').trim().toLowerCase()
      return String(sq.name ?? '').trim() === name && (!sqModule || sqModule.startsWith(module))
    })
    const uuid = match?.id ?? match?.uuid
    if (!uuid) {
      throw new Error(`Data scope references ${module} saved query "${name}", which was not found. Deploy the saved-queries config type first, or check the name.`)
    }
    uuids.push(uuid)
  }
  return uuids
}

// --- Body building ----------------------------------------------------------

/** JSON:API create body for a data scope. */
export function buildCreateBody(fields: {
  name: string
  description: string
  devicesQueries: string[]
  usersQueries: string[]
}): { data: { type: string; attributes: Record<string, unknown> } } {
  return {
    data: {
      type: DATA_SCOPE_SCHEMA_TYPE,
      attributes: {
        name: fields.name,
        description: fields.description,
        devices_queries: fields.devicesQueries,
        users_queries: fields.usersQueries,
      },
    },
  }
}

/** JSON:API update body for a data scope — the uuid is carried in the body too (verified DataScopeUpdateSchema). */
export function buildUpdateBody(fields: {
  uuid: string
  name: string
  description: string
  devicesQueries: string[]
  usersQueries: string[]
}): { data: { type: string; attributes: Record<string, unknown> } } {
  return {
    data: {
      type: DATA_SCOPE_SCHEMA_TYPE,
      attributes: {
        uuid: fields.uuid,
        name: fields.name,
        description: fields.description,
        devices_queries: fields.devicesQueries,
        users_queries: fields.usersQueries,
      },
    },
  }
}

/** JSON:API update body that restores a prior data-scope snapshot verbatim (used by rollback). */
export function buildRestoreBody(uuid: string, attributes: Record<string, unknown>): {
  data: { type: string; attributes: Record<string, unknown> }
} {
  return buildUpdateBody({
    uuid,
    name: String(attributes.name ?? ''),
    description: String(attributes.description ?? ''),
    devicesQueries: Array.isArray(attributes.devices_queries) ? (attributes.devices_queries as string[]) : [],
    usersQueries: Array.isArray(attributes.users_queries) ? (attributes.users_queries as string[]) : [],
  })
}

// --- Response parsing ---------------------------------------------------------

/**
 * Flatten the Data Scopes GET document into its `scopes` array. Unlike most
 * Axonius list endpoints this is ONE JSON:API document whose `attributes.scopes`
 * is a plain array of scope objects (not individually JSON:API-wrapped rows).
 */
export function dataScopesFromResponse(json: unknown): AxoniusDataScope[] {
  const data = (json as { data?: { attributes?: { scopes?: unknown } } })?.data
  const scopes = data?.attributes?.scopes
  return Array.isArray(scopes) ? (scopes as AxoniusDataScope[]) : []
}

/** The uuid of a data scope. */
export function dataScopeId(scope: AxoniusDataScope | null | undefined): string | null {
  const id = scope?.uuid
  return typeof id === 'string' && id ? id : null
}

/** Find a live data scope by name — the stable identity used to upsert. */
export function findDataScope(list: AxoniusDataScope[], name: string): AxoniusDataScope | null {
  const n = name.trim()
  if (!n) return null
  return list.find((s) => String(s.name ?? '').trim() === n) ?? null
}
