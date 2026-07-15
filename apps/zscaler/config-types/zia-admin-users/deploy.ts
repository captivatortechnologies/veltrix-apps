import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildZscalerClient,
  parseJson,
  zscalerErrorMessage,
  type ZscalerClient,
} from '../../lib/zscaler'
import {
  extractAdminUserSpecs,
  type AdminUserSpec,
  type LiveAdminRole,
  type LiveAdminUser,
} from './validate'

/**
 * State captured for rollback. This deliberately holds NO password: the ZIA
 * admin password is a WRITE-ONLY secret that is never returned on GET and is
 * never sent on an update, so it can be neither captured nor restored — and must
 * never be persisted into rollback data.
 */
export interface AdminUserRollbackEntry {
  loginName: string
  existed: boolean
  /** Numeric id ZIA assigned — the rollback key (never the login name). */
  id?: number
  /** Prior NON-SECRET state captured before an update, replayed on rollback. */
  prior?: {
    userName?: string
    email?: string
    roleId?: number
    comments?: string
    disabled?: boolean
  }
}

/**
 * Deploy ZIA admin users via the Zscaler OneAPI.
 *
 * Identity is the LOGIN NAME (ZIA has no upsert): list /adminUsers, match by
 * loginName, then PUT an existing account or POST a new one. Each admin
 * references its role by NAME, so this lists /adminRoles ONCE up front and
 * resolves each role name to its id — an unknown role name fails the deploy.
 * ZIA STAGES every write — nothing takes effect until activation — so this
 * writes all accounts, then calls activate() ONCE at the end. If activation
 * fails the writes remain staged and rollbackData is returned so the platform
 * can revert them.
 *
 * ⚠ SECRET HANDLING: `password` is write-only in ZIA. It is sent ONLY on a
 * CREATE (POST) — see buildCreatePayload — and is NEVER sent on an UPDATE (PUT),
 * NEVER captured into rollbackData, NEVER placed in artifacts, and NEVER logged.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, vanity } = built

  const specs = extractAdminUserSpecs(ctx.canvas).filter((s) => s.loginName)
  const rollbackState: AdminUserRollbackEntry[] = []
  const createdIds: number[] = []
  const deployed: string[] = []

  try {
    // Resolve role NAMES → ids from the live tenant, once.
    const roleIdByName = await buildRoleNameIndex(client)

    const existing = await listAdminUsers(client)
    const byLoginName = new Map(
      existing.filter((u) => u.loginName).map((u) => [u.loginName as string, u]),
    )

    for (const spec of specs) {
      const roleId = resolveRoleId(spec, roleIdByName)
      const live = byLoginName.get(spec.loginName)

      if (live && live.id != null) {
        // Capture prior NON-SECRET state only — the password is never present on
        // a live user and is never stored here.
        rollbackState.push({
          loginName: spec.loginName,
          existed: true,
          id: live.id,
          prior: {
            userName: live.userName,
            email: live.email,
            roleId: live.role?.id,
            comments: live.comments ?? '',
            disabled: live.disabled ?? false,
          },
        })
        // UPDATE: never send the password (buildUpdatePayload omits it).
        const res = await client.zia('PUT', `/adminUsers/${live.id}`, {
          body: buildUpdatePayload(spec, roleId),
        })
        if (!res.ok) {
          throw new Error(`Failed to update admin user "${spec.loginName}": ${zscalerErrorMessage(res)}`)
        }
      } else {
        // CREATE: the password is required and is sent ONLY here (buildCreatePayload).
        const res = await client.zia('POST', '/adminUsers', {
          body: buildCreatePayload(spec, roleId),
        })
        if (!res.ok) {
          throw new Error(`Failed to create admin user "${spec.loginName}": ${zscalerErrorMessage(res)}`)
        }
        const created = parseJson<LiveAdminUser>(res.body)
        if (created?.id == null) {
          throw new Error(`Admin user "${spec.loginName}" was created but the API returned no id`)
        }
        rollbackState.push({ loginName: spec.loginName, existed: false, id: created.id })
        createdIds.push(created.id)
      }

      deployed.push(spec.loginName)
    }

    // ZIA changes are staged — push them to production once, after all writes.
    const act = await client.activate()
    if (!act.ok) {
      return {
        success: false,
        message: `Staged ${deployed.length} ZIA admin user(s) but activation failed: ${zscalerErrorMessage(
          act,
        )}. The changes are saved but not active — re-run to retry activation.`,
        artifacts: { vanity, deployedUsers: deployed },
        rollbackData: { previousState: rollbackState, createdIds },
      }
    }

    return {
      success: true,
      message: `Deployed and activated ${deployed.length} ZIA admin user(s) on tenant "${vanity}": ${deployed.join(
        ', ',
      )}`,
      artifacts: { vanity, deployedUsers: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Admin user deployment failed after ${deployed.length} of ${specs.length} user(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { vanity, deployedUsers: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** List all ZIA admin users; throws on a non-OK response. */
export async function listAdminUsers(client: ZscalerClient): Promise<LiveAdminUser[]> {
  const res = await client.ziaGetAll<LiveAdminUser>('/adminUsers')
  if (!res.ok) {
    throw new Error(
      `Failed to list admin users: ${zscalerErrorMessage({ status: res.status, ok: false, body: res.body })}`,
    )
  }
  return res.items
}

/** Find an admin user by login name; null when absent. */
export async function findAdminUser(client: ZscalerClient, loginName: string): Promise<LiveAdminUser | null> {
  const all = await listAdminUsers(client)
  return all.find((u) => u.loginName === loginName) ?? null
}

/**
 * List all ZIA admin roles. ziaGetAll handles the paged/array response; if it
 * yields nothing (some tenants return a bare array GET /adminRoles that paging
 * can miss), fall back to a direct GET and parse the array.
 */
export async function listAdminRoles(client: ZscalerClient): Promise<LiveAdminRole[]> {
  const res = await client.ziaGetAll<LiveAdminRole>('/adminRoles')
  if (res.ok && res.items.length > 0) return res.items
  const direct = await client.zia('GET', '/adminRoles')
  if (!direct.ok) {
    throw new Error(`Failed to list admin roles: ${zscalerErrorMessage(direct)}`)
  }
  const arr = parseJson<LiveAdminRole[]>(direct.body)
  return Array.isArray(arr) ? arr : []
}

/** Build a name → id index of every live admin role. */
async function buildRoleNameIndex(client: ZscalerClient): Promise<Map<string, number>> {
  const roles = await listAdminRoles(client)
  const index = new Map<string, number>()
  for (const role of roles) {
    if (role.name && role.id != null) index.set(role.name, role.id)
  }
  return index
}

/** Resolve a spec's role name to a role id; throws when the role is unknown. */
function resolveRoleId(spec: AdminUserSpec, index: Map<string, number>): number {
  const id = index.get(spec.roleName)
  if (id == null) {
    throw new Error(
      `Admin user "${spec.loginName}" references role "${spec.roleName}", which does not exist in the tenant — create it first (ZIA Admin Roles) or correct the name`,
    )
  }
  return id
}

/**
 * Build the POST /adminUsers create body. This is the ONLY place the write-only
 * password is sent to ZIA. deploy guarantees it is present (validate requires
 * it), but this stays defensive and only includes it when set.
 */
export function buildCreatePayload(spec: AdminUserSpec, roleId: number): Record<string, unknown> {
  const body: Record<string, unknown> = {
    loginName: spec.loginName,
    userName: spec.userName,
    email: spec.email,
    role: { id: roleId },
    // comments always sent (even empty) so clearing it converges the account.
    comments: spec.comments ?? '',
    disabled: spec.disabled,
  }
  if (spec.password) body.password = spec.password
  return body
}

/**
 * Build the PUT /adminUsers/{id} update body — NON-SECRET fields only.
 * The password is DELIBERATELY omitted: it is write-only and must never be sent
 * on an update (a blank/unchanged password would otherwise clobber the existing
 * one, and we can never read it back to compare). Any password the author
 * supplied for an existing account is discarded here.
 */
export function buildUpdatePayload(spec: AdminUserSpec, roleId: number): Record<string, unknown> {
  return {
    loginName: spec.loginName,
    userName: spec.userName,
    email: spec.email,
    role: { id: roleId },
    comments: spec.comments ?? '',
    disabled: spec.disabled,
  }
}
