import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildOktaClient,
  parseJson,
  oktaErrorMessage,
  type OktaClient,
} from '../../lib/okta'
import {
  extractGroupSpecs,
  isReservedGroupName,
  type GroupSpec,
  type LiveGroup,
  type LiveGroupUser,
} from './validate'

/** OKTA_GROUP is the only type this config type manages. */
export const OKTA_GROUP_TYPE = 'OKTA_GROUP'
/** Members are read one page deep — Okta's list page cap for group users. */
export const MEMBER_READ_LIMIT = 200

export interface GroupRollbackEntry {
  name: string
  existed: boolean
  id?: string
  /** Prior profile, captured before an update so rollback can restore it. */
  prior?: { name: string; description: string }
  /** Whether this deploy managed the group's membership. */
  managedMembership: boolean
  /** Prior static member IDs (only captured when membership was managed on update). */
  priorMembers?: string[]
}

/**
 * Deploy Okta groups via the Groups API.
 *
 * ONE item = ONE OKTA_GROUP group, matched on profile.name:
 *   - list  GET /groups?filter=type eq "OKTA_GROUP"   (client.getAll, paginated)
 *   - PUT   /groups/{id}   — replace the profile of an existing OKTA_GROUP
 *   - POST  /groups        — create a missing one (capture new id)
 *
 * BUILT_IN and APP_GROUP groups are read-only: before creating, deploy refuses
 * if a live group of another type already owns the name, and the reserved name
 * "Everyone" is rejected outright (validate rejects it too).
 *
 * Membership is OPT-IN: only when manageMembership is on does deploy reconcile
 * the group's STATIC members to exactly memberUserIds (add missing / remove
 * extra). When off, membership is never read or written.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractGroupSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: GroupRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []
  // canvas item id -> okta group id, persisted in rollbackData so the NEXT deploy
  // matches (and can rename) the same group by id instead of creating a duplicate.
  const resourceIds: Record<string, string> = {}
  const priorResourceIds = await readPriorResourceIds(ctx)

  try {
    // List every OKTA_GROUP once; match candidates in memory by profile.name.
    const oktaGroups = await listOktaGroups(client)

    for (const spec of specs) {
      // Never manage a reserved built-in name (validate already rejects it).
      if (isReservedGroupName(spec.name)) {
        throw new Error(`Refusing to manage reserved built-in group "${spec.name}"`)
      }

      // Match order: (1) the external id stored for this canvas item on the last
      // deploy — RENAME-SAFE: a name change still updates the SAME group; (2) by
      // profile.name for the first deploy / items with no stored id (or whose
      // stored id no longer resolves to a live OKTA_GROUP).
      let existing: LiveGroup | null = null
      const priorId = spec.itemId ? priorResourceIds[spec.itemId] : undefined
      if (priorId) {
        existing = await getGroupById(client, priorId)
      }
      if (!existing) {
        existing = findGroupByName(oktaGroups, spec.name)
      }
      let groupId: string

      if (existing?.id) {
        // Update path — replace the profile, capturing the prior for rollback.
        groupId = existing.id
        rollbackState.push({
          name: spec.name,
          existed: true,
          id: groupId,
          prior: {
            name: existing.profile?.name ?? spec.name,
            description:
              typeof existing.profile?.description === 'string' ? existing.profile.description : '',
          },
          managedMembership: spec.manageMembership,
        })

        const res = await client.request('PUT', `/groups/${groupId}`, { body: buildProfileBody(spec) })
        if (!res.ok) {
          throw new Error(`Failed to update group "${spec.name}": ${oktaErrorMessage(res)}`)
        }
      } else {
        // Create path — but first refuse if a non-OKTA_GROUP owns this name.
        const conflict = await findConflictingGroup(client, spec.name)
        if (conflict) {
          throw new Error(
            `Refusing to create group "${spec.name}": a ${conflict.type ?? 'non-OKTA_GROUP'} group ` +
              'already exists with this name and only OKTA_GROUP groups can be managed',
          )
        }

        const res = await client.request('POST', '/groups', { body: buildProfileBody(spec) })
        if (!res.ok) {
          throw new Error(`Failed to create group "${spec.name}": ${oktaErrorMessage(res)}`)
        }
        const created = parseJson<LiveGroup>(res.body)
        if (!created?.id) {
          throw new Error(`Group "${spec.name}" was created but the API returned no id`)
        }
        groupId = created.id
        createdIds.push(groupId)
        rollbackState.push({
          name: spec.name,
          existed: false,
          id: groupId,
          managedMembership: spec.manageMembership,
        })
      }

      // Remember the resolved id for this canvas item (rename-safe next deploy).
      if (spec.itemId) resourceIds[spec.itemId] = groupId

      // Membership is OPT-IN. Only reconcile when explicitly enabled; when off,
      // never read or write membership.
      if (spec.manageMembership) {
        const current = await getCurrentMemberIds(client, groupId)
        // Attach the prior member set to the (already-pushed) rollback entry.
        const entry = rollbackState[rollbackState.length - 1]
        entry.priorMembers = current
        await reconcileMembership(client, groupId, spec, current)
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} group(s) to Okta org at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedGroups: deployed },
      // resourceIds carries the item->group-id identity map forward (rename-safe).
      rollbackData: { previousState: rollbackState, createdIds, resourceIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Group deployment failed after ${deployed.length} of ${specs.length} group(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedGroups: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      // Carry forward the ids resolved so far so a retry stays rename-safe.
      rollbackData: {
        previousState: rollbackState,
        createdIds,
        resourceIds: { ...priorResourceIds, ...resourceIds },
      },
    }
  }
}

// --- Helpers ------------------------------------------------------------------

/** List every OKTA_GROUP in the org, following pagination. */
export async function listOktaGroups(client: OktaClient): Promise<LiveGroup[]> {
  const filter = encodeURIComponent(`type eq "${OKTA_GROUP_TYPE}"`)
  const res = await client.getAll<LiveGroup>(`/groups?filter=${filter}`)
  if (!res.ok) {
    // getAll returns items/status/body but no nextUrl — adapt for oktaErrorMessage.
    throw new Error(
      `Failed to list OKTA_GROUP groups: ${oktaErrorMessage({ status: res.status, ok: res.ok, body: res.body, nextUrl: null })}`,
    )
  }
  return res.items
}

/** Find an OKTA_GROUP by exact profile.name; null when absent. */
export function findGroupByName(groups: LiveGroup[], name: string): LiveGroup | null {
  return groups.find((g) => g.type === OKTA_GROUP_TYPE && g.profile?.name === name) ?? null
}

/**
 * Read the canvas-item-id -> group-id map this canvas stored on its last
 * SUCCEEDED deploy (rollbackData.resourceIds), so a rename can update the same
 * group by id. Best-effort — {} when there is no prior deploy or the read fails.
 */
async function readPriorResourceIds(ctx: DeployContext): Promise<Record<string, string>> {
  try {
    const prior = await ctx.platform.getLatestDeployment(ctx.canvas.canvasId, { status: 'SUCCEEDED' })
    const rb = prior?.rollbackData as { resourceIds?: Record<string, string> } | undefined
    return rb?.resourceIds ?? {}
  } catch {
    return {}
  }
}

/**
 * Fetch a group by id, returning it only when it is a live OKTA_GROUP. Returns
 * null on 404 / any non-ok / a non-OKTA_GROUP, so a stale or repurposed stored id
 * cleanly falls back to name matching.
 */
async function getGroupById(client: OktaClient, id: string): Promise<LiveGroup | null> {
  const res = await client.request('GET', `/groups/${encodeURIComponent(id)}`)
  if (!res.ok) return null
  const group = parseJson<LiveGroup>(res.body)
  return group && group.id && group.type === OKTA_GROUP_TYPE ? group : null
}

/**
 * Detect a live group of a NON-OKTA_GROUP type that already owns `name`.
 * Uses `q` (name startsWith) then exact-matches, so a BUILT_IN ("Everyone") or
 * APP_GROUP with this name is surfaced and the create is refused.
 */
export async function findConflictingGroup(client: OktaClient, name: string): Promise<LiveGroup | null> {
  const res = await client.request('GET', '/groups', { query: { q: name, limit: MEMBER_READ_LIMIT } })
  if (!res.ok) {
    throw new Error(`Failed to check for a name conflict on group "${name}": ${oktaErrorMessage(res)}`)
  }
  const groups = parseJson<LiveGroup[]>(res.body) ?? []
  return groups.find((g) => g.profile?.name === name && g.type && g.type !== OKTA_GROUP_TYPE) ?? null
}

/**
 * Read a group's current static member IDs (one page, limit 200).
 * NOTE: rule-assigned members also appear here — see driftDetect / the canvas
 * warning; they cannot be removed via this API.
 */
export async function getCurrentMemberIds(client: OktaClient, groupId: string): Promise<string[]> {
  const res = await client.request('GET', `/groups/${groupId}/users`, { query: { limit: MEMBER_READ_LIMIT } })
  if (!res.ok) {
    throw new Error(`Failed to list members of group ${groupId}: ${oktaErrorMessage(res)}`)
  }
  const users = parseJson<LiveGroupUser[]>(res.body) ?? []
  return users.map((u) => u.id).filter((id): id is string => typeof id === 'string' && id.length > 0)
}

/** Converge a group's static membership to exactly spec.memberUserIds. */
async function reconcileMembership(
  client: OktaClient,
  groupId: string,
  spec: GroupSpec,
  current: string[],
): Promise<void> {
  const desired = new Set(spec.memberUserIds)
  const currentSet = new Set(current)

  // Add users that should be members but are not yet.
  for (const userId of spec.memberUserIds) {
    if (!currentSet.has(userId)) {
      const res = await client.request('PUT', `/groups/${groupId}/users/${userId}`)
      if (!res.ok) {
        throw new Error(`Failed to add user ${userId} to group "${spec.name}": ${oktaErrorMessage(res)}`)
      }
    }
  }

  // Remove users that are members but should not be.
  for (const userId of current) {
    if (!desired.has(userId)) {
      const res = await client.request('DELETE', `/groups/${groupId}/users/${userId}`)
      if (res.status !== 404 && !res.ok) {
        throw new Error(
          `Failed to remove user ${userId} from group "${spec.name}": ${oktaErrorMessage(res)} ` +
            '(a rule-assigned member cannot be removed via this API)',
        )
      }
    }
  }
}

/** Build the { profile: { name, description } } body for create / replace. */
function buildProfileBody(spec: GroupSpec): Record<string, unknown> {
  // description is always sent (empty string when absent) so a PUT converges the
  // live group and drift detection agrees about the target state.
  return { profile: { name: spec.name, description: spec.description ?? '' } }
}
