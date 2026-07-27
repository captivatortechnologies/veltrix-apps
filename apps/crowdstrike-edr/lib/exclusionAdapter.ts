// =============================================================================
// Shared adapter for the Falcon exclusion family (/policy/entities/*-exclusions).
//
// ML, IOA, and Sensor-Visibility exclusions share the same transport:
//   - query ids:  GET /policy/queries/<type>-exclusions/v1?filter=<field>:'…'
//   - get:        GET /policy/entities/<type>-exclusions/v1?ids=…
//   - create:     POST   /policy/entities/<type>-exclusions/v1
//   - update:     PATCH  /policy/entities/<type>-exclusions/v1   (body has id)
//   - delete:     DELETE /policy/entities/<type>-exclusions/v1?ids=…&comment=…
//
// Their bodies differ (ML/SV match on `value`, IOA on `name`; IOA adds regex
// fields), so each config type builds its own create/update body and drift
// diff; this module owns find / get / create / update / delete transport and
// host-group extraction. The FalconClient query serializer can't emit repeated
// `ids=` params, so id lists are encoded directly into the request path.
// =============================================================================

import {
  falconErrorMessage,
  falconFailure,
  fqlEscape,
  parseEnvelope,
  type FalconClient,
} from './falcon'

export interface ExclusionEndpoints {
  /** Entity path, e.g. '/policy/entities/ml-exclusions/v1'. */
  entity: string
  /** Queries path, e.g. '/policy/queries/ml-exclusions/v1'. */
  queries: string
  /** Field an existing exclusion is matched on: 'value' (ML/SV) or 'name' (IOA). */
  identityField: 'value' | 'name'
}

export interface LiveExclusion {
  id?: string
  value?: string
  name?: string
  applied_globally?: boolean
  groups?: Array<{ id?: string; name?: string } | string>
  comment?: string
  last_modified?: string
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

/** Host-group ids attached to a live exclusion (groups may be ids or {id} objects). */
export function exclusionGroupIds(ex: LiveExclusion): string[] {
  return (ex.groups ?? [])
    .map((g) => (typeof g === 'string' ? g : g?.id))
    .filter((id): id is string => typeof id === 'string')
}

/** Fetch full exclusion entities by id. */
export async function getExclusions(
  client: FalconClient,
  endpoints: ExclusionEndpoints,
  ids: string[],
): Promise<LiveExclusion[]> {
  if (ids.length === 0) return []
  const res = await client.request('GET', `${endpoints.entity}${idsQuery(ids)}`)
  if (!res.ok) throw new Error(`Failed to load exclusions: ${falconErrorMessage(res)}`)
  return parseEnvelope<LiveExclusion>(res.body)?.resources ?? []
}

/**
 * Find an exclusion by exact identity (value or name), paging the id query and
 * pinning the exact identity client-side. Returns null when none matches.
 */
export async function findExclusion(
  client: FalconClient,
  endpoints: ExclusionEndpoints,
  identity: string,
): Promise<LiveExclusion | null> {
  const limit = 500
  const field = endpoints.identityField
  for (let offset = 0; ; offset += limit) {
    const res = await client.request('GET', endpoints.queries, {
      query: { filter: `${field}:'${fqlEscape(identity)}'`, limit, offset },
    })
    if (!res.ok) {
      throw new Error(`Failed to search exclusion "${identity}": ${falconErrorMessage(res)}`)
    }
    const ids = (parseEnvelope<string>(res.body)?.resources ?? []).filter(
      (id): id is string => typeof id === 'string',
    )
    if (ids.length > 0) {
      const entities = await getExclusions(client, endpoints, ids)
      const exact = entities.find((e) => (field === 'value' ? e.value : e.name) === identity)
      if (exact) return exact
    }
    if (ids.length < limit) break
  }
  return null
}

/** Create an exclusion; returns the created id (or throws). */
export async function createExclusion(
  client: FalconClient,
  endpoints: ExclusionEndpoints,
  body: Record<string, unknown>,
): Promise<string> {
  const res = await client.request('POST', endpoints.entity, { body })
  const failure = falconFailure(res)
  if (failure) throw new Error(`Failed to create exclusion: ${failure}`)
  const id = parseEnvelope<LiveExclusion>(res.body)?.resources?.[0]?.id
  if (!id) throw new Error('Exclusion created but the API returned no id')
  return id
}

/** Update an exclusion (body must include its id). */
export async function updateExclusion(
  client: FalconClient,
  endpoints: ExclusionEndpoints,
  body: Record<string, unknown>,
): Promise<void> {
  const res = await client.request('PATCH', endpoints.entity, { body })
  const failure = falconFailure(res)
  if (failure) throw new Error(`Failed to update exclusion: ${failure}`)
}

/** Delete an exclusion by id, with an optional audit comment. */
export async function deleteExclusion(
  client: FalconClient,
  endpoints: ExclusionEndpoints,
  id: string,
  comment?: string,
): Promise<void> {
  const res = await client.request(
    'DELETE',
    `${endpoints.entity}${idsQuery([id], comment ? { comment } : {})}`,
  )
  const failure = falconFailure(res)
  if (failure) throw new Error(`Failed to delete exclusion: ${failure}`)
}
