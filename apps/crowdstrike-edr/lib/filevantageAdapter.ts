// =============================================================================
// Shared adapter for the Falcon FileVantage family (/filevantage/entities/*).
//
// FileVantage (File Integrity Monitoring) is a self-contained collection whose
// policies, rule-groups, and scheduled-exclusions all share the same transport:
//   - query ids:  GET /filevantage/queries/<kind>/v1?filter=name:'…'
//   - get:        GET /filevantage/entities/<kind>/v1?ids=…
//   - create:     POST   /filevantage/entities/<kind>/v1
//   - update:     PATCH  /filevantage/entities/<kind>/v1   (body carries id)
//   - delete:     DELETE /filevantage/entities/<kind>/v1?ids=…
//
// Every FileVantage object is identified by `name`. Host-group / rule-group
// assignment and precedence are POLICY-specific side endpoints (…/policies-
// host-groups, …/policies-rule-groups, …/policies-precedence) handled in the
// policy handler, not here. Mirrors the exclusionAdapter transport shape; the
// FalconClient query serializer can't repeat `ids=`, so id lists are encoded
// directly into the request path.
// =============================================================================

import {
  falconErrorMessage,
  falconFailure,
  fqlEscape,
  parseEnvelope,
  type FalconClient,
} from './falcon'

export interface FileVantageEndpoints {
  /** Entity path, e.g. '/filevantage/entities/policies/v1'. */
  entity: string
  /** Queries path, e.g. '/filevantage/queries/policies/v1'. */
  queries: string
}

export interface LiveFileVantageEntity {
  id?: string
  name?: string
  description?: string
  enabled?: boolean
  platform?: string
  created_timestamp?: string
  modified_timestamp?: string
  modified_by?: string
  [key: string]: unknown
}

/** Build a `?ids=a&ids=b&extra=…` query string (FalconClient can't repeat keys). */
function idsQuery(ids: string[], extra: Record<string, string> = {}): string {
  const parts = ids.map((id) => `ids=${encodeURIComponent(id)}`)
  for (const [key, value] of Object.entries(extra)) {
    parts.push(`${key}=${encodeURIComponent(value)}`)
  }
  return parts.length ? `?${parts.join('&')}` : ''
}

/** Fetch full FileVantage entities by id. */
export async function getFileVantageEntities(
  client: FalconClient,
  endpoints: FileVantageEndpoints,
  ids: string[],
): Promise<LiveFileVantageEntity[]> {
  if (ids.length === 0) return []
  const res = await client.request('GET', `${endpoints.entity}${idsQuery(ids)}`)
  if (!res.ok) throw new Error(`Failed to load FileVantage entities: ${falconErrorMessage(res)}`)
  return parseEnvelope<LiveFileVantageEntity>(res.body)?.resources ?? []
}

/**
 * Find a FileVantage object by exact name, paging the id query and pinning the
 * exact name client-side (a single unambiguous case-insensitive match is
 * tolerated). Returns null when none matches.
 */
export async function findFileVantageByName(
  client: FalconClient,
  endpoints: FileVantageEndpoints,
  name: string,
): Promise<LiveFileVantageEntity | null> {
  const limit = 500
  const caseInsensitive: LiveFileVantageEntity[] = []
  for (let offset = 0; ; offset += limit) {
    const res = await client.request('GET', endpoints.queries, {
      query: { filter: `name:'${fqlEscape(name)}'`, limit, offset },
    })
    if (!res.ok) {
      throw new Error(`Failed to search FileVantage "${name}": ${falconErrorMessage(res)}`)
    }
    const ids = (parseEnvelope<string>(res.body)?.resources ?? []).filter(
      (id): id is string => typeof id === 'string',
    )
    if (ids.length > 0) {
      const entities = await getFileVantageEntities(client, endpoints, ids)
      const exact = entities.find((e) => e.name === name)
      if (exact) return exact
      caseInsensitive.push(...entities.filter((e) => e.name?.toLowerCase() === name.toLowerCase()))
    }
    if (ids.length < limit) break
  }
  return caseInsensitive.length === 1 ? caseInsensitive[0] : null
}

/** Create a FileVantage object; returns the new id (or throws). */
export async function createFileVantage(
  client: FalconClient,
  endpoints: FileVantageEndpoints,
  body: Record<string, unknown>,
): Promise<string> {
  const res = await client.request('POST', endpoints.entity, { body })
  const failure = falconFailure(res)
  if (failure) throw new Error(`Failed to create FileVantage object: ${failure}`)
  const id = parseEnvelope<LiveFileVantageEntity>(res.body)?.resources?.[0]?.id
  if (!id) throw new Error('FileVantage object created but the API returned no id')
  return id
}

/** Update a FileVantage object (body must include its id). */
export async function updateFileVantage(
  client: FalconClient,
  endpoints: FileVantageEndpoints,
  body: Record<string, unknown>,
): Promise<void> {
  const res = await client.request('PATCH', endpoints.entity, { body })
  const failure = falconFailure(res)
  if (failure) throw new Error(`Failed to update FileVantage object: ${failure}`)
}

/** Delete a FileVantage object by id. */
export async function deleteFileVantage(
  client: FalconClient,
  endpoints: FileVantageEndpoints,
  id: string,
): Promise<void> {
  const res = await client.request('DELETE', `${endpoints.entity}${idsQuery([id])}`)
  const failure = falconFailure(res)
  if (failure) throw new Error(`Failed to delete FileVantage object: ${failure}`)
}
