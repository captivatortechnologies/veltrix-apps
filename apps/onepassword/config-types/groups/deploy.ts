import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildOnePasswordClient, buildPatchOp, parseJson, scimErrorMessage, type OnePasswordClient } from '../../lib/onePassword'
import { listUsers } from '../users/deploy'
import { extractGroupSpecs, type GroupSpec, type LiveGroup } from './validate'

const GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group'

export interface GroupRollbackEntry {
  displayName: string
  /** false = deploy CREATED this group (rollback clears its membership - there is no confirmed delete). */
  existed: boolean
  id?: string
  /** The group's exact live member id set before this deploy touched it (existing groups only). */
  priorMemberIds?: string[]
}

/**
 * Deploy 1Password custom Groups via the SCIM Bridge's Groups API.
 *
 * ONE item = ONE group, matched on `displayName` (the bridge has no upsert):
 *   - list      GET   /Groups             (client.listAll, ListResponse-paginated)
 *   - list      GET   /Users              - to resolve declared member emails
 *     to the bridge's current user ids (members are addressed by id, not
 *     email, in the SCIM Group schema)
 *   - create    POST  /Groups             - missing groups only (created with
 *     just `displayName`; members are then set the same way as an existing
 *     group, below, for one uniform reconciliation path)
 *   - membership PATCH /Groups/{id}       - a SCIM PatchOp that REPLACES the
 *     `members` multi-valued attribute wholesale - 1Password's documented
 *     "manage access to groups" capability. ALWAYS sent (even an empty
 *     array, to converge a cleared membership), matching every other
 *     full-replace membership/assignment config type in this codebase.
 *
 * A member email with no matching live user FAILS the deploy with a clear
 * message rather than silently being dropped - validate.ts only checks
 * shape, not existence, so this is the one place a stale/typo'd email is
 * actually caught.
 *
 * Never issues a DELETE - see README.md Coverage. Rollback of a group THIS
 * deploy created clears its membership rather than deleting the group
 * object, which remains until removed by hand if that's truly intended.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildOnePasswordClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractGroupSpecs(ctx.canvas).filter((s) => s.displayName)
  const rollbackState: GroupRollbackEntry[] = []
  const deployed: string[] = []

  try {
    const [groups, users] = await Promise.all([listGroups(client), listUsers(client)])
    const idByEmail = new Map(users.filter((u) => u.userName).map((u) => [u.userName!.toLowerCase(), u.id]))

    for (const spec of specs) {
      const memberIds = resolveMemberIds(spec, idByEmail)
      const live = groups.find((g) => (g.displayName ?? '').toLowerCase() === spec.displayName.toLowerCase()) ?? null

      let groupId: string
      if (!live) {
        const res = await client.request('POST', '/Groups', { body: { schemas: [GROUP_SCHEMA], displayName: spec.displayName } })
        if (!res.ok) {
          throw new Error(`Failed to create group "${spec.displayName}": ${scimErrorMessage(res)}`)
        }
        const created = parseJson<LiveGroup>(res.body)
        if (!created?.id) {
          throw new Error(`Group "${spec.displayName}" was created but the bridge returned no id`)
        }
        groupId = created.id
        rollbackState.push({ displayName: spec.displayName, existed: false, id: groupId })
      } else {
        if (!live.id) {
          throw new Error(`Group "${spec.displayName}" was found but the bridge returned no id`)
        }
        groupId = live.id
        rollbackState.push({
          displayName: spec.displayName,
          existed: true,
          id: groupId,
          priorMemberIds: (live.members ?? []).map((m) => m.value).filter((v): v is string => Boolean(v)),
        })
      }

      await setGroupMembers(client, groupId, memberIds, spec.displayName)
      deployed.push(spec.displayName)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} group(s) to the 1Password SCIM Bridge at ${baseUrl}: ${deployed.join(', ')}.`,
      artifacts: { baseUrl, deployedGroups: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Group deployment failed after ${deployed.length} of ${specs.length} group(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedGroups: deployed },
      rollbackData: { previousState: rollbackState },
    }
  }
}

// --- Helpers -------------------------------------------------------------------

/** List every group on the bridge, following SCIM ListResponse pagination. */
export async function listGroups(client: OnePasswordClient): Promise<LiveGroup[]> {
  const res = await client.listAll<LiveGroup>('/Groups')
  if (!res.ok) {
    throw new Error(`Failed to list groups: ${scimErrorMessage({ status: res.status, ok: res.ok, body: res.body })}`)
  }
  return res.items
}

/** Resolve a group's declared member emails to live user ids; throws listing every unresolved email at once. */
export function resolveMemberIds(spec: GroupSpec, idByEmail: Map<string, string | undefined>): string[] {
  const missing: string[] = []
  const ids: string[] = []
  for (const email of spec.memberUserNames) {
    const id = idByEmail.get(email.toLowerCase())
    if (!id) missing.push(email)
    else ids.push(id)
  }
  if (missing.length > 0) {
    throw new Error(
      `Group "${spec.displayName}" declares member(s) that do not exist on the 1Password SCIM Bridge: ${missing.join(', ')}. ` +
        'Provision them with this app\'s Users configuration type first, or remove them from this group.',
    )
  }
  return ids
}

/** PATCH /Groups/{id} - full replace of the group's members. */
export async function setGroupMembers(client: OnePasswordClient, groupId: string, memberIds: string[], displayName: string): Promise<void> {
  const res = await client.request('PATCH', `/Groups/${encodeURIComponent(groupId)}`, {
    body: buildPatchOp([{ op: 'replace', path: 'members', value: memberIds.map((id) => ({ value: id })) }]),
  })
  if (!res.ok) {
    throw new Error(`Failed to set members for group "${displayName}": ${scimErrorMessage(res)}`)
  }
}
