import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildAdminClient, resolveGrant, MISSING_CREDENTIAL_MESSAGE } from '../../lib/keycloakApi'
import type { KeycloakIdpRep } from './_shared'

/**
 * Undo an identity-providers deploy from rollbackData.previous (written by
 * deploy()): for each entry, PUT /identity-provider/instances/{alias} with the
 * prior representation (restore), or — when the provider was newly created (prior
 * body null) — DELETE /identity-provider/instances/{alias} to remove it. Applied
 * over the Keycloak Admin REST API.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ alias: string; idp: KeycloakIdpRep | null }>
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
    for (const { alias, idp } of previous) {
      if (!alias) continue
      if (idp) {
        const res = await admin.put(`/identity-provider/instances/${encodeURIComponent(alias)}`, idp)
        if (!res.ok) throw new Error(`restore ${alias} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
        restored++
      } else {
        const res = await admin.delete(`/identity-provider/instances/${encodeURIComponent(alias)}`)
        // A 404 means it is already gone — treat that as success.
        if (!res.ok && res.status !== 404) {
          throw new Error(`delete ${alias} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
        }
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back identity providers: ${restored} restored, ${deleted} deleted.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
