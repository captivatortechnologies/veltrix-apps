import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildAdminClient, resolveGrant, MISSING_CREDENTIAL_MESSAGE } from '../../lib/keycloakApi'
import type { KeycloakClientRoleRep } from './_shared'

/**
 * Undo a client-roles deploy from rollbackData.previous (written by deploy()):
 * for each entry, PUT /clients/{clientUuid}/roles/{role-name} with the prior
 * representation (restore), or — when the role was newly created (prior body
 * null) — DELETE .../roles/{role-name} to remove it. Applied over the Keycloak
 * Admin REST API, targeting the clientUuid RESOLVED at deploy time (not
 * re-resolved from clientId here), so a client rename between deploy and
 * rollback does not misdirect the rollback. If the stored clientUuid itself is
 * gone (the client was deleted), the role's own path 404s too — that is treated
 * as "already gone" for both restore and delete, not a failure.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ clientId: string; clientUuid: string; name: string; role: KeycloakClientRoleRep | null }>
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
    for (const { clientUuid, name, role } of previous) {
      if (!clientUuid || !name) continue

      if (role) {
        const res = await admin.put(`/clients/${encodeURIComponent(clientUuid)}/roles/${encodeURIComponent(name)}`, role)
        if (res.ok) {
          restored++
        } else if (res.status === 404) {
          // The client (or the role itself) is already gone — nothing to restore.
          skipped++
        } else {
          throw new Error(`restore ${name} on client ${clientUuid} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
        }
      } else {
        const res = await admin.delete(`/clients/${encodeURIComponent(clientUuid)}/roles/${encodeURIComponent(name)}`)
        // A 404 means it (or its parent client) is already gone — treat that as success.
        if (!res.ok && res.status !== 404) {
          throw new Error(`delete ${name} on client ${clientUuid} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
        }
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back client roles: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
