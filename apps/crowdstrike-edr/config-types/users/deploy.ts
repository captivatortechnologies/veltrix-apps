import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildFalconClient,
  falconErrorMessage,
  falconFailure,
  fqlEscape,
  parseEnvelope,
  type FalconClient,
} from '../../lib/falcon'
import { extractUserSpecs, type LiveUser, type LiveUserRole, type UserSpec } from './validate'

/** User state captured at deploy time so rollback can reverse exactly what changed. */
export interface UserRollbackEntry {
  email: string
  existed: boolean
  uuid?: string
  /** true when this deploy changed the user's name. */
  nameChanged?: boolean
  priorFirstName?: string
  priorLastName?: string
  /** Roles this deploy granted — rollback revokes them. */
  rolesGranted: string[]
  /** Roles this deploy revoked — rollback re-grants them. */
  rolesRevoked: string[]
}

/**
 * Deploy Falcon users via the User Management API.
 *
 * For each declared user:
 *   - GET  /user-management/queries/users/v1?filter=uid:'…'  — find by email
 *   - POST /user-management/entities/users/GET/v1            — read prior state
 *   - POST /user-management/entities/users/v1                — create (invite)
 *   - PATCH /user-management/entities/users/v1?user_uuid=…   — rename existing
 *   - GET  /user-management/combined/user-roles/v2           — read direct roles
 *   - POST /user-management/entities/user-role-actions/v1    — grant/revoke
 *
 * Users are created WITHOUT a password: Falcon sends an activation invite. This
 * app never sets or handles credentials. Roles are converged as a second step
 * (they cannot be set on create); roles are only touched when the item declares
 * at least one role id.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractUserSpecs(ctx.canvas).filter((s) => s.email)
  const rollbackState: UserRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const existing = await findUserByEmail(client, spec.email)
      const entry: UserRollbackEntry = {
        email: spec.email,
        existed: Boolean(existing),
        rolesGranted: [],
        rolesRevoked: [],
      }

      let uuid: string
      if (existing?.uuid) {
        uuid = existing.uuid
        entry.uuid = uuid
        await renameIfNeeded(client, spec, existing, entry)
      } else {
        uuid = await createUser(client, spec)
        entry.uuid = uuid
      }
      rollbackState.push(entry)

      if (spec.manageRoles) {
        await convergeRoles(client, uuid, spec.roleIds, entry)
      }

      deployed.push(spec.email)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} Falcon user(s) at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedUsers: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `User deployment failed after ${deployed.length} of ${specs.length} user(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedUsers: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState },
    }
  }
}

// --- Helpers ---

/** Look up a user by email (uid); null when absent. */
export async function findUserByEmail(client: FalconClient, email: string): Promise<LiveUser | null> {
  const queryRes = await client.request('GET', '/user-management/queries/users/v1', {
    query: { filter: `uid:'${fqlEscape(email)}'`, limit: 5 },
  })
  if (!queryRes.ok) {
    throw new Error(`Failed to search user "${email}": ${falconErrorMessage(queryRes)}`)
  }

  const ids = (parseEnvelope<string>(queryRes.body)?.resources ?? []).filter(
    (id): id is string => typeof id === 'string',
  )
  if (ids.length === 0) return null

  const detailRes = await client.request('POST', '/user-management/entities/users/GET/v1', {
    body: { ids },
  })
  if (!detailRes.ok) {
    throw new Error(`Failed to read user "${email}": ${falconErrorMessage(detailRes)}`)
  }
  const users = parseEnvelope<LiveUser>(detailRes.body)?.resources ?? []
  // Pin the exact uid — the filter should be exact, but never adopt a user the
  // canvas never declared.
  return users.find((u) => (u.uid ?? '').toLowerCase() === email.toLowerCase()) ?? null
}

/**
 * Create a user via invite (no password). Returns the new user's uuid, falling
 * back to a lookup by email when the create response omits it.
 */
async function createUser(client: FalconClient, spec: UserSpec): Promise<string> {
  const body: Record<string, unknown> = { uid: spec.email }
  if (spec.firstName) body.first_name = spec.firstName
  if (spec.lastName) body.last_name = spec.lastName

  const res = await client.request('POST', '/user-management/entities/users/v1', { body })
  const failure = falconFailure(res)
  if (failure) {
    throw new Error(`Failed to create user "${spec.email}": ${failure}`)
  }

  const created = parseEnvelope<LiveUser>(res.body)?.resources?.[0]
  let uuid = created?.uuid
  if (!uuid) {
    uuid = (await findUserByEmail(client, spec.email))?.uuid
  }
  if (!uuid) {
    throw new Error(`User "${spec.email}" was created but the API returned no user uuid`)
  }
  return uuid
}

/** Rename an existing user to the declared name, recording prior names for rollback. */
async function renameIfNeeded(
  client: FalconClient,
  spec: UserSpec,
  existing: LiveUser,
  entry: UserRollbackEntry,
): Promise<void> {
  const body: Record<string, unknown> = {}
  if (spec.firstName !== undefined && spec.firstName !== (existing.first_name ?? '')) {
    body.first_name = spec.firstName
  }
  if (spec.lastName !== undefined && spec.lastName !== (existing.last_name ?? '')) {
    body.last_name = spec.lastName
  }
  if (Object.keys(body).length === 0) return

  entry.nameChanged = true
  entry.priorFirstName = existing.first_name ?? ''
  entry.priorLastName = existing.last_name ?? ''

  const res = await client.request('PATCH', '/user-management/entities/users/v1', {
    query: { user_uuid: existing.uuid },
    body,
  })
  const failure = falconFailure(res)
  if (failure) {
    throw new Error(`Failed to update user "${spec.email}": ${failure}`)
  }
}

/** Read the user's DIRECT role grants (excludes inherited flight-control grants). */
export async function getUserRoleIds(client: FalconClient, uuid: string): Promise<string[]> {
  const res = await client.request('GET', '/user-management/combined/user-roles/v2', {
    query: { user_uuid: uuid, direct_only: true },
  })
  if (!res.ok) {
    throw new Error(`Failed to read roles for user ${uuid}: ${falconErrorMessage(res)}`)
  }
  return (parseEnvelope<LiveUserRole>(res.body)?.resources ?? [])
    .map((r) => r.role_id)
    .filter((id): id is string => typeof id === 'string')
}

/** grant or revoke a set of role ids for a user. No-op for an empty set. */
export async function roleAction(
  client: FalconClient,
  uuid: string,
  action: 'grant' | 'revoke',
  roleIds: string[],
): Promise<void> {
  if (roleIds.length === 0) return
  const res = await client.request('POST', '/user-management/entities/user-role-actions/v1', {
    body: { action, uuid, role_ids: roleIds },
  })
  const failure = falconFailure(res)
  if (failure) {
    throw new Error(`Failed to ${action} role(s) ${roleIds.join(', ')} for user ${uuid}: ${failure}`)
  }
}

/**
 * Converge a user's direct role grants to exactly the declared set: grant the
 * missing ones, revoke the extra ones, and record both deltas so rollback can
 * reverse precisely what changed.
 */
export async function convergeRoles(
  client: FalconClient,
  uuid: string,
  declared: string[],
  entry: UserRollbackEntry,
): Promise<void> {
  const current = await getUserRoleIds(client, uuid)
  const declaredSet = new Set(declared)
  const currentSet = new Set(current)

  const toGrant = declared.filter((r) => !currentSet.has(r))
  const toRevoke = current.filter((r) => !declaredSet.has(r))

  // Record the intended deltas BEFORE issuing each batch action: Falcon role
  // actions can partially apply and still return an envelope error, so recording
  // after would lose the applied changes for rollback. Rollback reversing a
  // grant/revoke that didn't actually apply is a harmless no-op.
  entry.rolesGranted = toGrant
  await roleAction(client, uuid, 'grant', toGrant)
  entry.rolesRevoked = toRevoke
  await roleAction(client, uuid, 'revoke', toRevoke)
}
