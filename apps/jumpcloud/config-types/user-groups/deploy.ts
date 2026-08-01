import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildJumpCloudClient, jumpCloudErrorMessage, parseJson, type JumpCloudClient } from '../../lib/jumpcloudApi'
import {
  extractUserGroupSpecs,
  buildUserGroupBody,
  findUserGroupByName,
  priorFieldsOf,
  type JumpCloudUserGroup,
} from './_shared'

/** One rollback record per applied group. */
export interface UserGroupRollbackEntry {
  name: string
  /** Whether the group already existed (update) or was created by this deploy. */
  existed: boolean
  id?: string
  /** Prior managed fields, captured before an update so rollback can restore them. */
  prior?: Record<string, unknown>
}

/**
 * Deploy JumpCloud User Groups over the API v2 (/usergroups):
 *   list:   GET  /usergroups                     (paged; match candidates by name)
 *   update: PUT  /usergroups/{id}  with { name, description, membershipMethod, email? }
 *   create: POST /usergroups       with { name, description, membershipMethod, email? }
 *
 * The name is the stable identity used to upsert. Matching is RENAME-SAFE: each
 * group's JumpCloud id is recorded per canvas item in rollbackData.resourceIds, so
 * the next deploy matches (and can rename) the SAME group by id before falling
 * back to name. rollbackData also records, per group, the prior managed body (for
 * an update) or that it was created (so rollback can delete it).
 *
 * NOTE: the description / email / membershipMethod body fields should be verified
 * against a live JumpCloud — the public jcapi model markdown lists only `name`.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildJumpCloudClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const specs = extractUserGroupSpecs(ctx.canvas).filter((s) => s.name)
  const previousState: UserGroupRollbackEntry[] = []
  const createdIds: string[] = []
  const applied: string[] = []
  // canvas item id -> JumpCloud group id, persisted so the NEXT deploy matches
  // (and can rename) the same group by id instead of creating a duplicate.
  const resourceIds: Record<string, string> = {}
  const priorResourceIds = await readPriorResourceIds(ctx)

  try {
    const liveGroups = await listUserGroups(client)

    for (const spec of specs) {
      // Match order: (1) the id stored for this canvas item on the last deploy
      // (rename-safe), (2) by name for the first deploy / a stale stored id.
      let existing: JumpCloudUserGroup | null = null
      const priorId = spec.itemId ? priorResourceIds[spec.itemId] : undefined
      if (priorId) existing = await getUserGroupById(client, priorId)
      if (!existing) existing = findUserGroupByName(liveGroups, spec.name)

      const body = buildUserGroupBody(spec)
      let groupId: string

      if (existing?.id) {
        groupId = existing.id
        previousState.push({ name: spec.name, existed: true, id: groupId, prior: priorFieldsOf(existing) })
        const res = await client.request('PUT', `/usergroups/${encodeURIComponent(groupId)}`, { body })
        if (!res.ok) throw new Error(`Failed to update User Group "${spec.name}": ${jumpCloudErrorMessage(res)}`)
      } else {
        const res = await client.request('POST', '/usergroups', { body })
        if (!res.ok) throw new Error(`Failed to create User Group "${spec.name}": ${jumpCloudErrorMessage(res)}`)
        const created = parseJson<JumpCloudUserGroup>(res.body)
        if (!created?.id) throw new Error(`User Group "${spec.name}" was created but the API returned no id`)
        groupId = created.id
        createdIds.push(groupId)
        previousState.push({ name: spec.name, existed: false, id: groupId })
      }

      if (spec.itemId) resourceIds[spec.itemId] = groupId
      applied.push(spec.name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} User Group(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previousState, createdIds, resourceIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `User Group deploy failed after ${applied.length} of ${specs.length} group(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { applied },
      // Carry forward the ids resolved so far so a retry stays rename-safe.
      rollbackData: { previousState, createdIds, resourceIds: { ...priorResourceIds, ...resourceIds } },
    }
  }
}

// --- Helpers ------------------------------------------------------------------

/** List every User Group in the org, following pagination. */
export async function listUserGroups(client: JumpCloudClient): Promise<JumpCloudUserGroup[]> {
  const res = await client.listAll<JumpCloudUserGroup>('/usergroups')
  if (!res.ok) {
    throw new Error(`Failed to list User Groups: ${jumpCloudErrorMessage({ status: res.status, ok: res.ok, body: res.body })}`)
  }
  return res.items
}

/** Fetch a group by id, or null on 404 / any non-ok (a stale stored id falls back to name matching). */
export async function getUserGroupById(client: JumpCloudClient, id: string): Promise<JumpCloudUserGroup | null> {
  const res = await client.request('GET', `/usergroups/${encodeURIComponent(id)}`)
  if (!res.ok) return null
  const group = parseJson<JumpCloudUserGroup>(res.body)
  return group?.id ? group : null
}

/**
 * Read the canvas-item-id -> group-id map this canvas stored on its last
 * SUCCEEDED deploy (rollbackData.resourceIds). Best-effort — {} on no prior
 * deploy or a read error.
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
