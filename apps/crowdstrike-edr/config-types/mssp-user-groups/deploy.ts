import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildFalconClient,
  falconErrorMessage,
  falconFailure,
  parseEnvelope,
  type FalconClient,
  type FalconResponse,
} from '../../lib/falcon'
import { extractUserGroupSpecs, type UserGroupSpec, type LiveUserGroup } from './validate'

// =============================================================================
// Deploy MSSP (Flight Control) user groups + their member user UUIDs.
//
// REQUIRES PARENT-CID CREDENTIALS: the Flight Control API is only available to
// the parent CID of an MSSP tenant, and the API client must carry the "Flight
// Control (MSSP)" scope. On a non-MSSP tenant every call returns 403.
//
// The user group collection splits its verbs across two API versions — reads
// are on /v2, writes on /v1 — and wraps create/update bodies in `resources:
// [...]`, so it does not fit the generic entity adapter and is driven directly:
//   - GET    /mssp/queries/user-groups/v1?name=…          find id(s) by name
//   - GET    /mssp/entities/user-groups/v2?ids=…          read the group(s)
//   - POST   /mssp/entities/user-groups/v1                create (name/description)
//   - PATCH  /mssp/entities/user-groups/v1                update (carries user_group_id)
//   - DELETE /mssp/entities/user-groups/v1?user_group_ids=…
//   - GET    /mssp/entities/user-group-members/v2?ids=…   read member UUIDs
//   - POST   /mssp/entities/user-group-members/v1         add {user_group_id, user_uuids}
//   - DELETE /mssp/entities/user-group-members/v1         remove {user_group_id, user_uuids}
//
// Members are embedded: deploy upserts the group by its `name` identity, then
// converges the member UUIDs (adds missing, removes extra), recording the exact
// membership delta so rollback reverses only what this deploy changed.
// =============================================================================

export const USER_GROUPS_QUERY = '/mssp/queries/user-groups/v1'
export const USER_GROUPS_ENTITY_GET = '/mssp/entities/user-groups/v2'
export const USER_GROUPS_ENTITY_WRITE = '/mssp/entities/user-groups/v1'
export const USER_GROUP_MEMBERS_GET = '/mssp/entities/user-group-members/v2'
export const USER_GROUP_MEMBERS_WRITE = '/mssp/entities/user-group-members/v1'

/** User group fields + membership delta this deploy can reverse on rollback. */
export interface UserGroupRollbackEntry {
  name: string
  existed: boolean
  id?: string
  prior?: { name?: string; description?: string }
  /** Member UUIDs this deploy added / removed while converging the group. */
  memberDelta: { added: string[]; removed: string[] }
}

/**
 * Deploy user groups. For each declared group: find it by name, create it when
 * missing (else PATCH its description), then converge its member UUIDs to
 * exactly the declared set. Prior state + membership deltas fund rollback.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractUserGroupSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: UserGroupRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const existing = await findUserGroup(client, spec.name)
      const existingId = existing ? userGroupIdOf(existing) : undefined

      if (existing && existingId) {
        const liveUuids = await getUserGroupMembers(client, existingId)
        const { toAdd, toRemove } = partitionMembers(spec.userUuids, liveUuids)

        // Record the intended delta before mutating so a partially-applied
        // convergence still rolls back exactly what it touched.
        rollbackState.push({
          name: spec.name,
          existed: true,
          id: existingId,
          prior: { name: existing.name, description: existing.description ?? '' },
          memberDelta: { added: toAdd, removed: toRemove },
        })

        await updateUserGroup(client, existingId, spec.name, spec.description ?? '')
        await addUserGroupMembers(client, existingId, toAdd)
        await removeUserGroupMembers(client, existingId, toRemove)
      } else {
        const id = await createUserGroup(client, spec)
        rollbackState.push({
          name: spec.name,
          existed: false,
          id,
          memberDelta: { added: spec.userUuids, removed: [] },
        })
        await addUserGroupMembers(client, id, spec.userUuids)
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} MSSP user group(s) to Falcon tenant at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedGroups: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `MSSP user group deployment failed after ${deployed.length} of ${specs.length} group(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedGroups: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState },
    }
  }
}

// --- Helpers ---

/** The group's identifier — `id` on the v2 read, `user_group_id` on some responses. */
export function userGroupIdOf(group: LiveUserGroup): string | undefined {
  return group.id ?? group.user_group_id
}

/** Encode an id list into the path — the FalconClient serializer can't repeat `ids=`. */
function idsPath(base: string, ids: string[]): string {
  const qs = ids.map((id) => `ids=${encodeURIComponent(id)}`).join('&')
  return qs ? `${base}?${qs}` : base
}

/** Member UUIDs to add (declared, not live) and to remove (live, not declared). */
export function partitionMembers(
  declared: string[],
  live: string[],
): { toAdd: string[]; toRemove: string[] } {
  const liveSet = new Set(live)
  const declaredSet = new Set(declared)
  return {
    toAdd: declared.filter((uuid) => !liveSet.has(uuid)),
    toRemove: live.filter((uuid) => !declaredSet.has(uuid)),
  }
}

/**
 * Find a user group by exact name. The MSSP query is a `name=` lookup (not FQL),
 * so results are paged and the exact name pinned client-side; a single
 * unambiguous case-insensitive match is tolerated.
 */
export async function findUserGroup(client: FalconClient, name: string): Promise<LiveUserGroup | null> {
  const limit = 500
  const caseInsensitive: LiveUserGroup[] = []
  for (let offset = 0; ; offset += limit) {
    const res = await client.request('GET', USER_GROUPS_QUERY, { query: { name, limit, offset } })
    if (!res.ok) throw new Error(`Failed to search user group "${name}": ${falconErrorMessage(res)}`)
    const ids = (parseEnvelope<string>(res.body)?.resources ?? []).filter(
      (id): id is string => typeof id === 'string',
    )
    if (ids.length > 0) {
      const groups = await getUserGroupsByIds(client, ids)
      const exact = groups.find((g) => g.name === name)
      if (exact) return exact
      caseInsensitive.push(...groups.filter((g) => g.name?.toLowerCase() === name.toLowerCase()))
    }
    if (ids.length < limit) break
  }
  return caseInsensitive.length === 1 ? caseInsensitive[0] : null
}

async function getUserGroupsByIds(client: FalconClient, ids: string[]): Promise<LiveUserGroup[]> {
  if (ids.length === 0) return []
  const res = await client.request('GET', idsPath(USER_GROUPS_ENTITY_GET, ids))
  if (!res.ok) throw new Error(`Failed to read user groups: ${falconErrorMessage(res)}`)
  return parseEnvelope<LiveUserGroup>(res.body)?.resources ?? []
}

/** Read a user group's current member UUIDs (lowercased). */
export async function getUserGroupMembers(client: FalconClient, userGroupId: string): Promise<string[]> {
  const res = await client.request('GET', USER_GROUP_MEMBERS_GET, { query: { ids: userGroupId } })
  if (!res.ok) {
    throw new Error(`Failed to read members of user group ${userGroupId}: ${falconErrorMessage(res)}`)
  }
  const resource = parseEnvelope<{ user_group_id?: string; user_uuids?: string[] }>(res.body)
    ?.resources?.[0]
  const uuids = resource && Array.isArray(resource.user_uuids) ? resource.user_uuids : []
  return uuids.filter((u): u is string => typeof u === 'string').map((u) => u.toLowerCase())
}

/** Create a user group (name + description) and return its new id. */
export async function createUserGroup(client: FalconClient, spec: UserGroupSpec): Promise<string> {
  const res = await client.request('POST', USER_GROUPS_ENTITY_WRITE, {
    body: { resources: [{ name: spec.name, description: spec.description ?? '' }] },
  })
  const failure = falconFailure(res)
  if (failure) throw new Error(`Failed to create user group "${spec.name}": ${failure}`)
  const created = parseEnvelope<LiveUserGroup>(res.body)?.resources?.[0]
  const id = created ? userGroupIdOf(created) : undefined
  if (!id) throw new Error(`User group "${spec.name}" was created but the API returned no group id`)
  return id
}

/** Update a user group's name/description (body carries its user_group_id). */
export async function updateUserGroup(
  client: FalconClient,
  userGroupId: string,
  name: string,
  description: string,
): Promise<void> {
  const res = await client.request('PATCH', USER_GROUPS_ENTITY_WRITE, {
    body: { resources: [{ user_group_id: userGroupId, name, description }] },
  })
  const failure = falconFailure(res)
  if (failure) throw new Error(`Failed to update user group "${name}": ${failure}`)
}

/** Delete a user group by id. Returns the raw response so the caller handles 404. */
export async function deleteUserGroup(client: FalconClient, userGroupId: string): Promise<FalconResponse> {
  return client.request('DELETE', USER_GROUPS_ENTITY_WRITE, { query: { user_group_ids: userGroupId } })
}

/** Add member user UUIDs to a group. No-op for an empty list. */
export async function addUserGroupMembers(
  client: FalconClient,
  userGroupId: string,
  userUuids: string[],
): Promise<void> {
  if (userUuids.length === 0) return
  const res = await client.request('POST', USER_GROUP_MEMBERS_WRITE, {
    body: { resources: [{ user_group_id: userGroupId, user_uuids: userUuids }] },
  })
  const failure = falconFailure(res)
  if (failure) throw new Error(`Failed to add member user(s) to group ${userGroupId}: ${failure}`)
}

/** Remove member user UUIDs from a group. No-op for an empty list. */
export async function removeUserGroupMembers(
  client: FalconClient,
  userGroupId: string,
  userUuids: string[],
): Promise<void> {
  if (userUuids.length === 0) return
  const res = await client.request('DELETE', USER_GROUP_MEMBERS_WRITE, {
    body: { resources: [{ user_group_id: userGroupId, user_uuids: userUuids }] },
  })
  const failure = falconFailure(res)
  if (failure) throw new Error(`Failed to remove member user(s) from group ${userGroupId}: ${failure}`)
}
