import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildJumpCloudClient,
  jumpCloudErrorMessage,
  parseJson,
  JUMPCLOUD_API_BASE,
  PAGE_LIMIT,
  type JumpCloudClient,
} from '../../lib/jumpcloudApi'
import {
  extractMembershipSpecs,
  buildUserIndex,
  resolveMemberId,
  memberIdOf,
  diffMembers,
  buildMemberOp,
  type JumpCloudSystemUser,
  type GraphConnection,
  type UserIndex,
} from './_shared'

/** Minimal User Group shape for resolving the target group by name. */
interface UserGroupRef {
  id?: string
  name?: string
}

/** One rollback record per applied group membership. */
export interface MembershipRollbackEntry {
  groupName: string
  groupId: string
  /** User ids added by this deploy (rollback removes them). */
  added: string[]
  /** User ids removed by this deploy (rollback re-adds them). */
  removed: string[]
}

/**
 * Deploy JumpCloud User Group memberships over the API v2:
 *   resolve group:  GET  /usergroups                     (match the group by name)
 *   list members:   GET  /usergroups/{id}/members        (current membership)
 *   apply:          POST /usergroups/{id}/members         ({ op, type: user, id })
 *
 * Members declared by email / username are resolved to user ids via the v1
 * /systemusers directory; a raw 24-hex id is used directly. In exclusive mode the
 * canvas owns the full membership (extra live members are removed); otherwise the
 * deploy only adds the declared members.
 *
 * FLAGGED: the GraphConnection member shape and the v1 /systemusers wrapper should
 * be verified against a live JumpCloud tenant.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildJumpCloudClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const builtV1 = buildJumpCloudClient(ctx.credential, ctx.settings, { baseUrl: JUMPCLOUD_API_BASE })
  if ('error' in builtV1) return { success: false, message: builtV1.error }
  const v1 = builtV1.client

  const specs = extractMembershipSpecs(ctx.canvas).filter((s) => s.groupName)
  const previousState: MembershipRollbackEntry[] = []
  const applied: string[] = []

  try {
    const groups = await listUserGroups(client)
    const index = buildUserIndex(await listSystemUsers(v1))

    for (const spec of specs) {
      const group = findGroupByName(groups, spec.groupName)
      if (!group?.id) {
        throw new Error(`User Group "${spec.groupName}" was not found — create it (with the User Groups config type or in JumpCloud) before managing its membership.`)
      }

      const desiredIds = resolveDesired(spec.members, index, spec.groupName)
      const currentIds = await listMemberIds(client, group.id)
      const { toAdd, toRemove } = diffMembers(currentIds, desiredIds, spec.exclusive)

      for (const userId of toAdd) await applyMemberOp(client, group.id, 'add', userId, spec.groupName)
      for (const userId of toRemove) await applyMemberOp(client, group.id, 'remove', userId, spec.groupName)

      previousState.push({ groupName: spec.groupName, groupId: group.id, added: toAdd, removed: toRemove })
      applied.push(`${spec.groupName} (+${toAdd.length}/-${toRemove.length})`)
    }

    return {
      success: true,
      message: `Applied membership for ${previousState.length} group(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previousState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Membership deploy failed after ${previousState.length} of ${specs.length} group(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { applied },
      rollbackData: { previousState },
    }
  }
}

// --- Helpers ------------------------------------------------------------------

/** Resolve every declared member to a user id, failing loudly on an unknown user. */
function resolveDesired(members: string[], index: UserIndex, groupName: string): string[] {
  const ids = new Set<string>()
  const unresolved: string[] = []
  for (const member of members) {
    const id = resolveMemberId(member, index)
    if (id) ids.add(id)
    else unresolved.push(member)
  }
  if (unresolved.length > 0) {
    throw new Error(`Could not resolve ${unresolved.length} member(s) for "${groupName}": ${unresolved.join(', ')} — check the email / username or use the user id.`)
  }
  return [...ids]
}

/** List every User Group in the org, following pagination. */
export async function listUserGroups(client: JumpCloudClient): Promise<UserGroupRef[]> {
  const res = await client.listAll<UserGroupRef>('/usergroups')
  if (!res.ok) {
    throw new Error(`Failed to list User Groups: ${jumpCloudErrorMessage({ status: res.status, ok: res.ok, body: res.body })}`)
  }
  return res.items
}

/** Find a live User Group by name (case-insensitive). */
export function findGroupByName(groups: UserGroupRef[], name: string): UserGroupRef | null {
  const target = name.trim().toLowerCase()
  if (!target) return null
  return groups.find((g) => String(g.name ?? '').trim().toLowerCase() === target) ?? null
}

/** List the current member user ids of a group, following pagination. */
export async function listMemberIds(client: JumpCloudClient, groupId: string): Promise<string[]> {
  const res = await client.listAll<GraphConnection>(`/usergroups/${encodeURIComponent(groupId)}/members`)
  if (!res.ok) {
    throw new Error(`Failed to list members: ${jumpCloudErrorMessage({ status: res.status, ok: res.ok, body: res.body })}`)
  }
  return res.items.map(memberIdOf).filter(Boolean)
}

/** Apply one add/remove member operation. */
async function applyMemberOp(
  client: JumpCloudClient,
  groupId: string,
  op: 'add' | 'remove',
  userId: string,
  groupName: string,
): Promise<void> {
  const res = await client.request('POST', `/usergroups/${encodeURIComponent(groupId)}/members`, { body: buildMemberOp(op, userId) })
  if (!res.ok) {
    throw new Error(`Failed to ${op} member ${userId} on "${groupName}": ${jumpCloudErrorMessage(res)}`)
  }
}

/**
 * List every system user over the JumpCloud v1 API. Unlike the v2 list endpoints
 * (bare JSON arrays), v1 /systemusers returns a `{ results, totalCount }` wrapper,
 * so this walks limit/skip pagination itself. FLAGGED — verify the wrapper key.
 */
export async function listSystemUsers(v1: JumpCloudClient): Promise<JumpCloudSystemUser[]> {
  const users: JumpCloudSystemUser[] = []
  let skip = 0
  for (let page = 0; page < 1000; page++) {
    const res = await v1.request('GET', '/systemusers', { query: { limit: PAGE_LIMIT, skip } })
    if (!res.ok) {
      throw new Error(`Failed to list system users: ${jumpCloudErrorMessage(res)}`)
    }
    const parsed = parseJson<{ results?: JumpCloudSystemUser[] }>(res.body)
    const rows = parsed?.results ?? []
    if (!Array.isArray(rows) || rows.length === 0) break
    users.push(...rows)
    if (rows.length < PAGE_LIMIT) break
    skip += PAGE_LIMIT
  }
  return users
}
