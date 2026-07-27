// =============================================================================
// Transport for Falcon Cloud Security custom compliance frameworks.
//
// The generic lib/entityAdapter powers the query->get->pin shape and the
// delete-by-ids call, but the frameworks collection differs from the adapter's
// default assumptions in three verified ways, so find/create/update are
// implemented here against the FalconClient directly (the adapter's own header
// notes bespoke collections do exactly this):
//   - the query FILTER field is `compliance_framework_name`, not the entity's
//     `name` field, so the client-side identity pin is on `name`;
//   - the identifier is `uuid`, not `id`;
//   - update/delete take the id via the `ids` QUERY param, and the update body
//     carries no id.
// getEntities / deleteEntity from the adapter are reused unchanged.
// =============================================================================

import {
  falconErrorMessage,
  falconFailure,
  fqlEscape,
  parseEnvelope,
  type FalconClient,
} from '../../lib/falcon'
import { deleteEntity, getEntities, type EntityEndpoints } from '../../lib/entityAdapter'
import type { LiveFramework } from './validate'

export const FRAMEWORK_ENDPOINTS: EntityEndpoints = {
  entity: '/cloud-policies/entities/compliance/frameworks/v1',
  queries: '/cloud-policies/queries/compliance/frameworks/v1',
  identityField: 'name',
}

/** FQL filter property the frameworks query matches names on. */
const FRAMEWORK_NAME_FILTER = 'compliance_framework_name'

/** Read a framework's identifier — Cloud Security uses `uuid`, not `id`. */
export function frameworkId(framework: LiveFramework | null | undefined): string | undefined {
  const uuid = framework?.uuid
  if (typeof uuid === 'string' && uuid) return uuid
  const id = framework?.id
  return typeof id === 'string' && id ? id : undefined
}

/**
 * Find a framework by exact name: query ids by the `compliance_framework_name`
 * filter, fetch the entities, then pin the exact `name`. A single unambiguous
 * case-insensitive match is tolerated; otherwise null.
 */
export async function findFrameworkByName(
  client: FalconClient,
  name: string,
): Promise<LiveFramework | null> {
  const limit = 500
  const caseInsensitive: LiveFramework[] = []
  for (let offset = 0; ; offset += limit) {
    const res = await client.request('GET', FRAMEWORK_ENDPOINTS.queries, {
      query: { filter: `${FRAMEWORK_NAME_FILTER}:'${fqlEscape(name)}'`, limit, offset },
    })
    if (!res.ok) {
      throw new Error(`Failed to search framework "${name}": ${falconErrorMessage(res)}`)
    }
    const ids = (parseEnvelope<string>(res.body)?.resources ?? []).filter(
      (id): id is string => typeof id === 'string',
    )
    if (ids.length > 0) {
      const entities = (await getEntities(client, FRAMEWORK_ENDPOINTS, ids)) as LiveFramework[]
      const exact = entities.find((e) => e.name === name)
      if (exact) return exact
      caseInsensitive.push(
        ...entities.filter(
          (e) => typeof e.name === 'string' && e.name.toLowerCase() === name.toLowerCase(),
        ),
      )
    }
    if (ids.length < limit) break
  }
  return caseInsensitive.length === 1 ? caseInsensitive[0] : null
}

export interface FrameworkWriteFields {
  name: string
  description?: string
  active?: boolean
}

function frameworkBody(fields: FrameworkWriteFields): Record<string, unknown> {
  const body: Record<string, unknown> = { name: fields.name, active: fields.active ?? true }
  if (fields.description !== undefined) body.description = fields.description
  return body
}

/** Create a framework; returns its new uuid (or throws). */
export async function createFramework(
  client: FalconClient,
  fields: FrameworkWriteFields,
): Promise<string> {
  const res = await client.request('POST', FRAMEWORK_ENDPOINTS.entity, { body: frameworkBody(fields) })
  const failure = falconFailure(res)
  if (failure) throw new Error(`Failed to create framework "${fields.name}": ${failure}`)
  const created = parseEnvelope<LiveFramework>(res.body)?.resources?.[0]
  const uuid = frameworkId(created)
  if (!uuid) throw new Error(`Framework "${fields.name}" was created but the API returned no uuid`)
  return uuid
}

/** Update a framework by uuid (id travels in the `ids` query, not the body). */
export async function updateFramework(
  client: FalconClient,
  uuid: string,
  fields: FrameworkWriteFields,
): Promise<void> {
  const res = await client.request('PATCH', FRAMEWORK_ENDPOINTS.entity, {
    query: { ids: uuid },
    body: frameworkBody(fields),
  })
  const failure = falconFailure(res)
  if (failure) throw new Error(`Failed to update framework "${fields.name}": ${failure}`)
}

/** Delete a framework by uuid. */
export async function deleteFramework(client: FalconClient, uuid: string): Promise<void> {
  await deleteEntity(client, FRAMEWORK_ENDPOINTS, uuid)
}
