import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildAdminClient, resolveGrant, MISSING_CREDENTIAL_MESSAGE } from '../../lib/keycloakApi'
import { pathForKind, type AuthorizationKind, type KeycloakAuthorizationRep } from './_shared'

/**
 * Undo an authorization deploy from rollbackData.previous (written by
 * deploy()): for each entry, PUT the kind-appropriate {base}/{segment}/{id}
 * path with the prior representation (restore), or — when the object was
 * newly created (prior body null) — DELETE it. Uses the STORED
 * resolvedClientUuid directly rather than re-resolving clientId, so rollback
 * is unaffected by the client being renamed after this deploy ran.
 *
 * UNCONFIRMED assumption (see ./_shared.ts's header comment): PUT/DELETE
 * {base}/permission/{id} and {base}/policy/{id} work without a type segment
 * once the id is known — verify against a live Keycloak before relying on
 * this for permission/role-policy rollback in production.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{
      clientId: string
      resolvedClientUuid: string
      kind: AuthorizationKind
      name: string
      id: string | null
      rep: KeycloakAuthorizationRep | null
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
    for (const entry of previous) {
      if (entry.id == null) {
        // A created object whose id we never learned — nothing safe to undo.
        skipped++
        continue
      }
      const path = pathForKind(entry.kind, entry.resolvedClientUuid, entry.id)
      if (entry.rep) {
        const res = await admin.put(path, entry.rep)
        if (!res.ok) {
          throw new Error(`restore ${entry.kind} "${entry.name}" → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
        }
        restored++
      } else {
        const res = await admin.delete(path)
        // A 404 means it is already gone — treat that as success.
        if (!res.ok && res.status !== 404) {
          throw new Error(`delete ${entry.kind} "${entry.name}" → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
        }
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back authorization objects: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
