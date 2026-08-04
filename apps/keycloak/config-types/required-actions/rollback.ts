import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildAdminClient, resolveGrant, MISSING_CREDENTIAL_MESSAGE } from '../../lib/keycloakApi'
import type { KeycloakRequiredActionRep } from './_shared'

/**
 * Undo a required-actions deploy from rollbackData.previous (written by deploy()):
 * for each entry, PUT /authentication/required-actions/{alias} with the prior
 * representation (full restore), or — when we registered the action fresh in this
 * realm (prior body null) — DELETE /authentication/required-actions/{alias} to
 * fully de-register it back to its pre-deploy (unregistered) state. This is more
 * destructive than merely disabling it, so it is only ever used to undo an action
 * WE registered. Applied over the Keycloak Admin REST API.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ alias: string; prior: KeycloakRequiredActionRep | null }>
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
    for (const { alias, prior } of previous) {
      if (!alias) continue
      if (prior) {
        const res = await admin.put(`/authentication/required-actions/${encodeURIComponent(alias)}`, prior)
        if (!res.ok) throw new Error(`restore ${alias} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
        restored++
      } else {
        const res = await admin.delete(`/authentication/required-actions/${encodeURIComponent(alias)}`)
        // A 404 means it is already gone — treat that as success.
        if (!res.ok && res.status !== 404) {
          throw new Error(`delete ${alias} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
        }
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back required actions: ${restored} restored, ${deleted} deleted.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
