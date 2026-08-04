import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildClient,
  vqlTimeoutMs,
  readUsers,
  findUser,
  parseRoles,
  parsePermissions,
  buildPolicyDelta,
  userCreateVQL,
  userGrantPolicyVQL,
  GUI_USERS_VQL,
  type LiveUser,
} from './_shared'

/** One user's rollback record: prior state plus what this deploy applied. */
export interface UserRollbackEntry {
  name: string
  existed: boolean
  roles: string[] | null
  /** Prior custom permissions, when gui_users() surfaced them (best-effort). */
  permissions: string[] | null
  /** Custom permissions THIS deploy declared (empty when none authored). */
  desiredPermissions: string[]
}

/**
 * Deploy Velociraptor GUI users over the gRPC API (mutual TLS):
 *   read (rollback base): SELECT * FROM gui_users()                    — prior users
 *   upsert:                SELECT user_create(user=, roles=[...], password=)
 *   custom permissions:    SELECT user_grant(user=, policy={perm: true|false})
 *
 * The username is the stable identity. Named roles are always applied via
 * user_create; fine-grained custom permissions (beyond the named roles) are
 * applied via a follow-up user_grant(policy=) ONLY when either authored or
 * needed to clear a previously-granted permission that is no longer declared.
 * rollbackData records, per user, whether it existed before and its prior
 * roles/permissions (when gui_users() surfaces them) so rollback can delete a
 * newly-created user or re-grant its prior state.
 *
 * VERIFY against a live Velociraptor server: user_create() upsert semantics,
 * user_grant(policy=) clearing semantics, and the gui_users() columns (see
 * ./_shared.ts). A prior password cannot be restored.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for users-acls deployment' }
  }

  const previous: UserRollbackEntry[] = []
  const applied: string[] = []
  const timeoutMs = vqlTimeoutMs(settings)

  let client
  try {
    client = await buildClient(component, credential, connectivity, settings)
  } catch (error) {
    return { success: false, message: `Could not connect to Velociraptor: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }

  try {
    let live: LiveUser[] = []
    try {
      live = readUsers(await client.runVQL(GUI_USERS_VQL, { timeoutMs }))
    } catch {
      live = [] // best-effort: without prior state, created users roll back via delete
    }

    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      const roles = parseRoles(item.fields.roles)
      const password = String(item.fields.password ?? '')
      const desiredPermissions = parsePermissions(item.fields.customPermissions)
      if (!name || roles.length === 0) continue

      const existing = findUser(live, name)
      previous.push({
        name,
        existed: Boolean(existing),
        roles: existing ? existing.roles : null,
        permissions: existing ? existing.permissions : null,
        desiredPermissions,
      })

      await client.runVQL(userCreateVQL(name, roles, password || undefined), { timeoutMs })

      const policy = buildPolicyDelta(desiredPermissions, existing?.permissions ?? null)
      if (Object.keys(policy).length > 0) {
        await client.runVQL(userGrantPolicyVQL(name, policy), { timeoutMs })
      }

      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} user(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Users-acls deploy failed after ${applied.length} user(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } finally {
    await client.close().catch(() => {})
  }
}
