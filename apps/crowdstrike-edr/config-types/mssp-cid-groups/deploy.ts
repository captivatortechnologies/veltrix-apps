import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildFalconClient,
  falconErrorMessage,
  falconFailure,
  parseEnvelope,
  type FalconClient,
  type FalconResponse,
} from '../../lib/falcon'
import { extractCidGroupSpecs, type CidGroupSpec, type LiveCidGroup } from './validate'

// =============================================================================
// Deploy MSSP (Flight Control) CID groups + their member child CIDs.
//
// REQUIRES PARENT-CID CREDENTIALS: the Flight Control API is only available to
// the parent CID of an MSSP tenant, and the API client must carry the "Flight
// Control (MSSP)" scope. On a non-MSSP tenant every call returns 403.
//
// The CID group collection splits its verbs across two API versions — reads are
// on /v2, writes on /v1 — and wraps create/update bodies in `resources: [...]`,
// so it does not fit the generic entity adapter and is driven directly here:
//   - GET    /mssp/queries/cid-groups/v1?name=…         find id(s) by name
//   - GET    /mssp/entities/cid-groups/v2?ids=…         read the group(s)
//   - POST   /mssp/entities/cid-groups/v1               create (name/description)
//   - PATCH  /mssp/entities/cid-groups/v1               update (carries cid_group_id)
//   - DELETE /mssp/entities/cid-groups/v1?cid_group_ids=…
//   - GET    /mssp/entities/cid-group-members/v2?ids=…  read member CIDs
//   - POST   /mssp/entities/cid-group-members/v1        add members {cid_group_id, cids}
//   - DELETE /mssp/entities/cid-group-members/v1        remove members {cid_group_id, cids}
//
// Members are embedded: deploy upserts the group by its `name` identity, then
// converges the member CIDs (adds missing, removes extra), recording the exact
// membership delta so rollback reverses only what this deploy changed.
// =============================================================================

export const CID_GROUPS_QUERY = '/mssp/queries/cid-groups/v1'
export const CID_GROUPS_ENTITY_GET = '/mssp/entities/cid-groups/v2'
export const CID_GROUPS_ENTITY_WRITE = '/mssp/entities/cid-groups/v1'
export const CID_GROUP_MEMBERS_GET = '/mssp/entities/cid-group-members/v2'
export const CID_GROUP_MEMBERS_WRITE = '/mssp/entities/cid-group-members/v1'

/** CID group fields + membership delta this deploy can reverse on rollback. */
export interface CidGroupRollbackEntry {
  name: string
  existed: boolean
  id?: string
  prior?: { name?: string; description?: string }
  /** Member CIDs this deploy added / removed while converging the group. */
  memberDelta: { added: string[]; removed: string[] }
}

/**
 * Deploy CID groups. For each declared group: find it by name, create it when
 * missing (else PATCH its description), then converge its member CIDs to exactly
 * the declared set. Prior state + membership deltas are captured for rollback.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractCidGroupSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: CidGroupRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const existing = await findCidGroup(client, spec.name)
      const existingId = existing ? cidGroupIdOf(existing) : undefined

      if (existing && existingId) {
        const liveCids = await getCidGroupMembers(client, existingId)
        const { toAdd, toRemove } = partitionMembers(spec.cids, liveCids)

        // Record the intended delta before mutating so a partially-applied
        // convergence still rolls back exactly what it touched.
        rollbackState.push({
          name: spec.name,
          existed: true,
          id: existingId,
          prior: { name: existing.name, description: existing.description ?? '' },
          memberDelta: { added: toAdd, removed: toRemove },
        })

        await updateCidGroup(client, existingId, spec.name, spec.description ?? '')
        await addCidGroupMembers(client, existingId, toAdd)
        await removeCidGroupMembers(client, existingId, toRemove)
      } else {
        const id = await createCidGroup(client, spec)
        rollbackState.push({
          name: spec.name,
          existed: false,
          id,
          memberDelta: { added: spec.cids, removed: [] },
        })
        await addCidGroupMembers(client, id, spec.cids)
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} MSSP CID group(s) to Falcon tenant at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedGroups: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `MSSP CID group deployment failed after ${deployed.length} of ${specs.length} group(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedGroups: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState },
    }
  }
}

// --- Helpers ---

/** The group's identifier — `id` on the v2 read, `cid_group_id` on some responses. */
export function cidGroupIdOf(group: LiveCidGroup): string | undefined {
  return group.id ?? group.cid_group_id
}

/** Encode an id list into the path — the FalconClient serializer can't repeat `ids=`. */
function idsPath(base: string, ids: string[]): string {
  const qs = ids.map((id) => `ids=${encodeURIComponent(id)}`).join('&')
  return qs ? `${base}?${qs}` : base
}

/** Member CIDs to add (declared, not live) and to remove (live, not declared). */
export function partitionMembers(
  declared: string[],
  live: string[],
): { toAdd: string[]; toRemove: string[] } {
  const liveSet = new Set(live)
  const declaredSet = new Set(declared)
  return {
    toAdd: declared.filter((cid) => !liveSet.has(cid)),
    toRemove: live.filter((cid) => !declaredSet.has(cid)),
  }
}

/**
 * Find a CID group by exact name. The MSSP query is a `name=` lookup (not FQL),
 * so results are paged and the exact name pinned client-side; a single
 * unambiguous case-insensitive match is tolerated.
 */
export async function findCidGroup(client: FalconClient, name: string): Promise<LiveCidGroup | null> {
  const limit = 500
  const caseInsensitive: LiveCidGroup[] = []
  for (let offset = 0; ; offset += limit) {
    const res = await client.request('GET', CID_GROUPS_QUERY, { query: { name, limit, offset } })
    if (!res.ok) throw new Error(`Failed to search CID group "${name}": ${falconErrorMessage(res)}`)
    const ids = (parseEnvelope<string>(res.body)?.resources ?? []).filter(
      (id): id is string => typeof id === 'string',
    )
    if (ids.length > 0) {
      const groups = await getCidGroupsByIds(client, ids)
      const exact = groups.find((g) => g.name === name)
      if (exact) return exact
      caseInsensitive.push(...groups.filter((g) => g.name?.toLowerCase() === name.toLowerCase()))
    }
    if (ids.length < limit) break
  }
  return caseInsensitive.length === 1 ? caseInsensitive[0] : null
}

async function getCidGroupsByIds(client: FalconClient, ids: string[]): Promise<LiveCidGroup[]> {
  if (ids.length === 0) return []
  const res = await client.request('GET', idsPath(CID_GROUPS_ENTITY_GET, ids))
  if (!res.ok) throw new Error(`Failed to read CID groups: ${falconErrorMessage(res)}`)
  return parseEnvelope<LiveCidGroup>(res.body)?.resources ?? []
}

/** Read a CID group's current member child CIDs (lowercased). */
export async function getCidGroupMembers(client: FalconClient, cidGroupId: string): Promise<string[]> {
  const res = await client.request('GET', CID_GROUP_MEMBERS_GET, { query: { ids: cidGroupId } })
  if (!res.ok) {
    throw new Error(`Failed to read members of CID group ${cidGroupId}: ${falconErrorMessage(res)}`)
  }
  const resource = parseEnvelope<{ cid_group_id?: string; cids?: string[] }>(res.body)?.resources?.[0]
  const cids = resource && Array.isArray(resource.cids) ? resource.cids : []
  return cids.filter((c): c is string => typeof c === 'string').map((c) => c.toLowerCase())
}

/** Create a CID group (name + description) and return its new id. */
export async function createCidGroup(client: FalconClient, spec: CidGroupSpec): Promise<string> {
  const res = await client.request('POST', CID_GROUPS_ENTITY_WRITE, {
    body: { resources: [{ name: spec.name, description: spec.description ?? '' }] },
  })
  const failure = falconFailure(res)
  if (failure) throw new Error(`Failed to create CID group "${spec.name}": ${failure}`)
  const created = parseEnvelope<LiveCidGroup>(res.body)?.resources?.[0]
  const id = created ? cidGroupIdOf(created) : undefined
  if (!id) throw new Error(`CID group "${spec.name}" was created but the API returned no group id`)
  return id
}

/** Update a CID group's name/description (body carries its cid_group_id). */
export async function updateCidGroup(
  client: FalconClient,
  cidGroupId: string,
  name: string,
  description: string,
): Promise<void> {
  const res = await client.request('PATCH', CID_GROUPS_ENTITY_WRITE, {
    body: { resources: [{ cid_group_id: cidGroupId, name, description }] },
  })
  const failure = falconFailure(res)
  if (failure) throw new Error(`Failed to update CID group "${name}": ${failure}`)
}

/** Delete a CID group by id. Returns the raw response so the caller handles 404. */
export async function deleteCidGroup(client: FalconClient, cidGroupId: string): Promise<FalconResponse> {
  return client.request('DELETE', CID_GROUPS_ENTITY_WRITE, { query: { cid_group_ids: cidGroupId } })
}

/** Add member child CIDs to a group. No-op for an empty list. */
export async function addCidGroupMembers(
  client: FalconClient,
  cidGroupId: string,
  cids: string[],
): Promise<void> {
  if (cids.length === 0) return
  const res = await client.request('POST', CID_GROUP_MEMBERS_WRITE, {
    body: { resources: [{ cid_group_id: cidGroupId, cids }] },
  })
  const failure = falconFailure(res)
  if (failure) throw new Error(`Failed to add member CID(s) to group ${cidGroupId}: ${failure}`)
}

/** Remove member child CIDs from a group. No-op for an empty list. */
export async function removeCidGroupMembers(
  client: FalconClient,
  cidGroupId: string,
  cids: string[],
): Promise<void> {
  if (cids.length === 0) return
  const res = await client.request('DELETE', CID_GROUP_MEMBERS_WRITE, {
    body: { resources: [{ cid_group_id: cidGroupId, cids }] },
  })
  const failure = falconFailure(res)
  if (failure) throw new Error(`Failed to remove member CID(s) from group ${cidGroupId}: ${failure}`)
}
