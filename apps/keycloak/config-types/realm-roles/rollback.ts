import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildAdminClient, resolveGrant, MISSING_CREDENTIAL_MESSAGE } from '../../lib/keycloakApi'
import type { KeycloakRoleRep } from './_shared'

/**
 * Undo a realm-roles deploy from rollbackData.previous (written by deploy()): for
 * each entry, PUT /roles/{role-name} with the prior representation (restore), or —
 * when the role was newly created (prior body null) — DELETE /roles/{role-name} to
 * remove it. Applied over the Keycloak Admin REST API.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ name: string; role: KeycloakRoleRep | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!resolveGrant(credential)) {
    return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const admin = buildAdminClient({ component, connectivity, connectivityProvider, credential, settings })

  let restored = 0
  let deleted = 0
  try {
    for (const { name, role } of previous) {
      if (!name) continue
      if (role) {
        const res = await admin.put(`/roles/${encodeURIComponent(name)}`, role)
        if (!res.ok) throw new Error(`restore ${name} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
        restored++
      } else {
        const res = await admin.delete(`/roles/${encodeURIComponent(name)}`)
        // A 404 means it is already gone — treat that as success.
        if (!res.ok && res.status !== 404) {
          throw new Error(`delete ${name} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
        }
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back realm roles: ${restored} restored, ${deleted} deleted.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
