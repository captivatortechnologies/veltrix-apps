import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildAdminClient, resolveGrant, MISSING_CREDENTIAL_MESSAGE } from '../../lib/keycloakApi'
import { reconcileRealmRoles, type KeycloakGroupRep } from './_shared'

/**
 * Undo a groups deploy from rollbackData.previous (written by deploy()): for each
 * entry, PUT /groups/{id} with the prior representation and re-reconcile its realm
 * role mappings to the prior set (restore), or — when the group was newly created
 * (prior body null) — DELETE /groups/{id} to remove it (which also drops its role
 * mappings). Applied over the Keycloak Admin REST API.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ name: string; id: string | null; group: KeycloakGroupRep | null; priorRealmRoles?: string[] }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!resolveGrant(credential)) {
    return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const admin = buildAdminClient({ component, connectivity, connectivityProvider, credential, settings })

  let restored = 0
  let deleted = 0
  let skipped = 0
  try {
    for (const { id, group, priorRealmRoles } of previous) {
      if (id == null) {
        // A created group whose id we never learned — nothing safe to undo.
        skipped++
        continue
      }
      if (group) {
        const res = await admin.put(`/groups/${encodeURIComponent(id)}`, group)
        if (!res.ok) throw new Error(`restore ${id} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
        await reconcileRealmRoles(admin, id, priorRealmRoles ?? [])
        restored++
      } else {
        const res = await admin.delete(`/groups/${encodeURIComponent(id)}`)
        // A 404 means it is already gone — treat that as success.
        if (!res.ok && res.status !== 404) {
          throw new Error(`delete ${id} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
        }
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back groups: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
