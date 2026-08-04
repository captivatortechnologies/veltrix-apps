import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildJumpCloudClient, jumpCloudErrorMessage, parseJson, type JumpCloudClient } from '../../lib/jumpcloudApi'
import {
  extractPolicyGroupSpecs,
  buildPolicyGroupBody,
  findPolicyGroupByName,
  findPolicyRefByName,
  priorFieldsOf,
  memberIdOf,
  diffMembers,
  buildMemberOp,
  type JumpCloudPolicyGroup,
  type JumpCloudPolicyRef,
  type GraphConnection,
} from './_shared'

/** One rollback record per applied Policy Group. */
export interface PolicyGroupRollbackEntry {
  name: string
  /** Whether the group already existed (update) or was created by this deploy. */
  existed: boolean
  id?: string
  /** Prior managed body, captured before an update so rollback can restore it. */
  prior?: Record<string, unknown>
  /** Policy ids added by this deploy (rollback removes them). */
  added: string[]
  /** Policy ids removed by this deploy (rollback re-adds them). */
  removed: string[]
}

/**
 * Deploy JumpCloud Policy Groups over the API v2:
 *   list:   GET  /policygroups                     (paged; match candidates by name)
 *   update: PUT  /policygroups/{id}  with { name }
 *   create: POST /policygroups       with { name }
 *   members: GET  /policygroups/{id}/members  (current membership)
 *            POST /policygroups/{id}/members  ({ op, type: "policy", id })
 *
 * The name is the stable identity used to upsert the group. Member Policy names
 * are resolved to ids via GET /policies and membership is converged exclusively
 * (the canvas item owns the full member list). Matching the group itself is
 * RENAME-SAFE via the per-item resourceIds map, same as the other JumpCloud
 * config types.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildJumpCloudClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const specs = extractPolicyGroupSpecs(ctx.canvas).filter((s) => s.name)
  const previousState: PolicyGroupRollbackEntry[] = []
  const createdIds: string[] = []
  const applied: string[] = []
  const resourceIds: Record<string, string> = {}
  const priorResourceIds = await readPriorResourceIds(ctx)

  try {
    const liveGroups = await listPolicyGroups(client)
    const livePolicies = await listPoliciesForResolution(client)

    for (const spec of specs) {
      let existing: JumpCloudPolicyGroup | null = null
      const priorId = spec.itemId ? priorResourceIds[spec.itemId] : undefined
      if (priorId) existing = await getPolicyGroupById(client, priorId)
      if (!existing) existing = findPolicyGroupByName(liveGroups, spec.name)

      const body = buildPolicyGroupBody(spec)
      let groupId: string
      let prior: Record<string, unknown> | undefined

      if (existing?.id) {
        groupId = existing.id
        prior = priorFieldsOf(existing)
        const res = await client.request('PUT', `/policygroups/${encodeURIComponent(groupId)}`, { body })
        if (!res.ok) throw new Error(`Failed to update Policy Group "${spec.name}": ${jumpCloudErrorMessage(res)}`)
      } else {
        const res = await client.request('POST', '/policygroups', { body })
        if (!res.ok) throw new Error(`Failed to create Policy Group "${spec.name}": ${jumpCloudErrorMessage(res)}`)
        const created = parseJson<JumpCloudPolicyGroup>(res.body)
        if (!created?.id) throw new Error(`Policy Group "${spec.name}" was created but the API returned no id`)
        groupId = created.id
        createdIds.push(groupId)
      }

      const desiredIds = resolveDesiredPolicyIds(spec.memberPolicies, livePolicies, spec.name)
      const currentIds = await listMemberIds(client, groupId)
      const { toAdd, toRemove } = diffMembers(currentIds, desiredIds)

      for (const policyId of toAdd) await applyMemberOp(client, groupId, 'add', policyId, spec.name)
      for (const policyId of toRemove) await applyMemberOp(client, groupId, 'remove', policyId, spec.name)

      previousState.push({ name: spec.name, existed: Boolean(existing?.id), id: groupId, prior, added: toAdd, removed: toRemove })
      if (spec.itemId) resourceIds[spec.itemId] = groupId
      applied.push(`${spec.name} (+${toAdd.length}/-${toRemove.length} policies)`)
    }

    return {
      success: true,
      message: `Applied ${previousState.length} Policy Group(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previousState, createdIds, resourceIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Policy Group deploy failed after ${previousState.length} of ${specs.length} group(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { applied },
      rollbackData: { previousState, createdIds, resourceIds: { ...priorResourceIds, ...resourceIds } },
    }
  }
}

// --- Helpers ------------------------------------------------------------------

/** Resolve every declared member Policy name to a Policy id, failing loudly on an unknown Policy. */
function resolveDesiredPolicyIds(names: string[], policies: JumpCloudPolicyRef[], groupName: string): string[] {
  const ids = new Set<string>()
  const unresolved: string[] = []
  for (const name of names) {
    const match = findPolicyRefByName(policies, name)
    if (match?.id) ids.add(match.id)
    else unresolved.push(name)
  }
  if (unresolved.length > 0) {
    throw new Error(`Could not resolve ${unresolved.length} member Policy(ies) for "${groupName}": ${unresolved.join(', ')} — check the exact Policy name.`)
  }
  return [...ids]
}

/** List every Policy Group in the org, following pagination. */
export async function listPolicyGroups(client: JumpCloudClient): Promise<JumpCloudPolicyGroup[]> {
  const res = await client.listAll<JumpCloudPolicyGroup>('/policygroups')
  if (!res.ok) {
    throw new Error(`Failed to list Policy Groups: ${jumpCloudErrorMessage({ status: res.status, ok: res.ok, body: res.body })}`)
  }
  return res.items
}

/** Fetch a Policy Group by id, or null on 404 / any non-ok (a stale stored id falls back to name matching). */
export async function getPolicyGroupById(client: JumpCloudClient, id: string): Promise<JumpCloudPolicyGroup | null> {
  const res = await client.request('GET', `/policygroups/${encodeURIComponent(id)}`)
  if (!res.ok) return null
  const group = parseJson<JumpCloudPolicyGroup>(res.body)
  return group?.id ? group : null
}

/** List every Policy in the org (name + id only), for resolving declared member names. */
export async function listPoliciesForResolution(client: JumpCloudClient): Promise<JumpCloudPolicyRef[]> {
  const res = await client.listAll<JumpCloudPolicyRef>('/policies')
  if (!res.ok) {
    throw new Error(`Failed to list Policies: ${jumpCloudErrorMessage({ status: res.status, ok: res.ok, body: res.body })}`)
  }
  return res.items
}

/** List the current member Policy ids of a group, following pagination. */
export async function listMemberIds(client: JumpCloudClient, groupId: string): Promise<string[]> {
  const res = await client.listAll<GraphConnection>(`/policygroups/${encodeURIComponent(groupId)}/members`)
  if (!res.ok) {
    throw new Error(`Failed to list Policy Group members: ${jumpCloudErrorMessage({ status: res.status, ok: res.ok, body: res.body })}`)
  }
  return res.items.map(memberIdOf).filter(Boolean)
}

/** Apply one add/remove member operation. */
async function applyMemberOp(
  client: JumpCloudClient,
  groupId: string,
  op: 'add' | 'remove',
  policyId: string,
  groupName: string,
): Promise<void> {
  const res = await client.request('POST', `/policygroups/${encodeURIComponent(groupId)}/members`, { body: buildMemberOp(op, policyId) })
  if (!res.ok) {
    throw new Error(`Failed to ${op} member Policy ${policyId} on "${groupName}": ${jumpCloudErrorMessage(res)}`)
  }
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
