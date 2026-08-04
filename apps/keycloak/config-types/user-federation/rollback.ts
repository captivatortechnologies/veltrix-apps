import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildAdminClient, resolveGrant, MISSING_CREDENTIAL_MESSAGE } from '../../lib/keycloakApi'
import type { KeycloakComponentRep } from './_shared'

/**
 * Undo a user-federation deploy from rollbackData.previous (written by
 * deploy()): for each entry, PUT /components/{id} with the prior
 * representation — already stripped of bindCredential/keyTab by deploy() (see
 * _shared.ts's stripSecretsFromComponent) so this never overwrites a live
 * secret with Keycloak's masked "**********" placeholder — or, when the
 * component was newly created (prior body null), DELETE /components/{id} to
 * remove it (tolerating a 404 as already-gone). Applied over the Keycloak
 * Admin REST API.
 *
 * ASSUMPTION TO VERIFY against a live Keycloak: PUT /components/{id} is
 * assumed to leave an omitted config key (bindCredential/keyTab) untouched
 * rather than clearing it — see _shared.ts's stripSecretsFromComponent for
 * the full reasoning and the conservative fallback this design takes either way.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ name: string; id: string | null; component: KeycloakComponentRep | null }>
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
    for (const { id, component: prior } of [...previous].reverse()) {
      if (id == null) {
        // A created component whose id we never learned — nothing safe to undo.
        skipped++
        continue
      }
      if (prior) {
        const res = await admin.put(`/components/${encodeURIComponent(id)}`, prior)
        if (!res.ok) throw new Error(`restore ${id} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
        restored++
      } else {
        const res = await admin.delete(`/components/${encodeURIComponent(id)}`)
        // A 404 means it is already gone — treat that as success.
        if (!res.ok && res.status !== 404) {
          throw new Error(`delete ${id} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
        }
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back user federation providers: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
