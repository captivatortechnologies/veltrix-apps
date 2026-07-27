// =============================================================================
// Generic Falcon "query → get → CRUD by identity" adapter.
//
// Many Falcon collections share one transport shape:
//   - query ids:  GET <queries>?filter=<identityField>:'…'
//   - get:        GET <entity>?ids=…
//   - create:     POST   <entity>
//   - update:     PATCH  <entity>   (body carries id)
//   - delete:     DELETE <entity>?ids=…[&extra]
//
// The exclusion and FileVantage adapters are collection-specific instances of
// this; this generic version powers the Cloud Security config types (the
// /cloud-policies/ family — IOM custom rules, suppression rules, rule overrides,
// compliance frameworks/controls — plus Cloud Groups), all keyed by `name`.
// Collections with bespoke params (account registration, image assessment,
// registries, KAC) call the FalconClient directly instead. The FalconClient
// query serializer can't repeat `ids=`, so id lists are encoded into the path.
// =============================================================================

import {
  falconErrorMessage,
  falconFailure,
  fqlEscape,
  parseEnvelope,
  type FalconClient,
} from './falcon'

export interface EntityEndpoints {
  /** Entity path, e.g. '/cloud-policies/entities/rules/v1'. */
  entity: string
  /** Queries path, e.g. '/cloud-policies/queries/rules/v1'. */
  queries: string
  /** Field an existing object is matched on (default 'name'). */
  identityField?: string
}

export interface LiveEntity {
  id?: string
  name?: string
  description?: string
  modified_by?: string
  modified_timestamp?: string
  modified_on?: string
  [key: string]: unknown
}

function idsQuery(ids: string[], extra: Record<string, string> = {}): string {
  const parts = ids.map((id) => `ids=${encodeURIComponent(id)}`)
  for (const [key, value] of Object.entries(extra)) {
    parts.push(`${key}=${encodeURIComponent(value)}`)
  }
  return parts.length ? `?${parts.join('&')}` : ''
}

/** Fetch full entities by id. */
export async function getEntities(
  client: FalconClient,
  endpoints: EntityEndpoints,
  ids: string[],
): Promise<LiveEntity[]> {
  if (ids.length === 0) return []
  const res = await client.request('GET', `${endpoints.entity}${idsQuery(ids)}`)
  if (!res.ok) throw new Error(`Failed to load entities: ${falconErrorMessage(res)}`)
  return parseEnvelope<LiveEntity>(res.body)?.resources ?? []
}

/**
 * Find an object by exact identity (default field `name`), paging the id query
 * and pinning the exact identity client-side (a single unambiguous
 * case-insensitive match is tolerated). Returns null when none matches.
 */
export async function findEntityByIdentity(
  client: FalconClient,
  endpoints: EntityEndpoints,
  identity: string,
): Promise<LiveEntity | null> {
  const field = endpoints.identityField ?? 'name'
  const limit = 500
  const caseInsensitive: LiveEntity[] = []
  const valueOf = (e: LiveEntity): unknown => e[field]
  for (let offset = 0; ; offset += limit) {
    const res = await client.request('GET', endpoints.queries, {
      query: { filter: `${field}:'${fqlEscape(identity)}'`, limit, offset },
    })
    if (!res.ok) {
      throw new Error(`Failed to search "${identity}": ${falconErrorMessage(res)}`)
    }
    const ids = (parseEnvelope<string>(res.body)?.resources ?? []).filter(
      (id): id is string => typeof id === 'string',
    )
    if (ids.length > 0) {
      const entities = await getEntities(client, endpoints, ids)
      const exact = entities.find((e) => valueOf(e) === identity)
      if (exact) return exact
      caseInsensitive.push(
        ...entities.filter(
          (e) => typeof valueOf(e) === 'string' && (valueOf(e) as string).toLowerCase() === identity.toLowerCase(),
        ),
      )
    }
    if (ids.length < limit) break
  }
  return caseInsensitive.length === 1 ? caseInsensitive[0] : null
}

/** Create an object; returns the new id (or throws). */
export async function createEntity(
  client: FalconClient,
  endpoints: EntityEndpoints,
  body: Record<string, unknown>,
): Promise<string> {
  const res = await client.request('POST', endpoints.entity, { body })
  const failure = falconFailure(res)
  if (failure) throw new Error(`Failed to create object: ${failure}`)
  // Falcon create endpoints return the new id either as a bare string
  // (resources: ["<id>"]) or as an object (resources: [{ id }]) — tolerate both.
  const created = parseEnvelope<LiveEntity | string>(res.body)?.resources?.[0]
  const id = typeof created === 'string' ? created : created?.id
  if (!id) throw new Error('Object created but the API returned no id')
  return id
}

/** Update an object (body must include its id). */
export async function updateEntity(
  client: FalconClient,
  endpoints: EntityEndpoints,
  body: Record<string, unknown>,
): Promise<void> {
  const res = await client.request('PATCH', endpoints.entity, { body })
  const failure = falconFailure(res)
  if (failure) throw new Error(`Failed to update object: ${failure}`)
}

/** Delete an object by id, with optional extra query params (e.g. a parent id). */
export async function deleteEntity(
  client: FalconClient,
  endpoints: EntityEndpoints,
  id: string,
  extra: Record<string, string> = {},
): Promise<void> {
  const res = await client.request('DELETE', `${endpoints.entity}${idsQuery([id], extra)}`)
  const failure = falconFailure(res)
  if (failure) throw new Error(`Failed to delete object: ${failure}`)
}
