import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildAdminClient, resolveGrant, MISSING_CREDENTIAL_MESSAGE } from '../../lib/keycloakApi'
import { reconcileRealmDefaultState, resolveRealmDefaultState, type KeycloakClientScopeRep, type RealmDefaultState } from './_shared'

/**
 * Undo a client-scopes deploy from rollbackData.previous (written by deploy()):
 * for each entry, PUT /client-scopes/{id} with the prior representation and
 * reconcile its realm assignment back to the prior state (restore), or — when the
 * scope was newly created (prior body null) — DELETE /client-scopes/{id} to remove
 * it (which also drops its realm assignment). Applied over the Keycloak Admin
 * REST API.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{
      name: string
      id: string | null
      scope: KeycloakClientScopeRep | null
      priorRealmDefault?: RealmDefaultState
    }>
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
    for (const { id, scope, priorRealmDefault } of previous) {
      if (id == null) {
        // A created scope whose id we never learned — nothing safe to undo.
        skipped++
        continue
      }
      if (scope) {
        const res = await admin.put(`/client-scopes/${encodeURIComponent(id)}`, scope)
        if (!res.ok) throw new Error(`restore ${id} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
        const currentRealmDefault = await resolveRealmDefaultState(admin, id)
        await reconcileRealmDefaultState(admin, id, priorRealmDefault ?? 'none', currentRealmDefault)
        restored++
      } else {
        const res = await admin.delete(`/client-scopes/${encodeURIComponent(id)}`)
        // A 404 means it is already gone — treat that as success.
        if (!res.ok && res.status !== 404) {
          throw new Error(`delete ${id} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
        }
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back client scopes: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
