import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildAdminClient, resolveGrant, MISSING_CREDENTIAL_MESSAGE } from '../../lib/keycloakApi'
import type { KeycloakClientRep } from './_shared'

/**
 * Undo a clients deploy from rollbackData.previous (written by deploy()): for each
 * entry, PUT /clients/{id} with the prior representation (restore), or — when the
 * client was newly created (prior body null) — DELETE /clients/{id} to remove it.
 * Applied over the Keycloak Admin REST API.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ clientId: string; id: string | null; client: KeycloakClientRep | null }>
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
    for (const { id, client } of previous) {
      if (id == null) {
        // A created client whose id we never learned — nothing safe to undo.
        skipped++
        continue
      }
      if (client) {
        const res = await admin.put(`/clients/${encodeURIComponent(id)}`, client)
        if (!res.ok) throw new Error(`restore ${id} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
        restored++
      } else {
        const res = await admin.delete(`/clients/${encodeURIComponent(id)}`)
        // A 404 means it is already gone — treat that as success.
        if (!res.ok && res.status !== 404) {
          throw new Error(`delete ${id} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
        }
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back clients: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
